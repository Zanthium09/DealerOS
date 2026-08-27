import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PlatformSession, signPlatformSession } from './platform-session';
import { matchTotpStep, newSecret } from './totp';

export const ADMIN_BCRYPT_COST = 12;

// Same anti-enumeration trick as the tenant flow, separate copy (§9A.2).
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), ADMIN_BCRYPT_COST);

type AdminRow = {
  id: string;
  email: string;
  role: string;
  passwordHash: string | null;
  mfaEnabled: boolean;
  mfaSecret: string | null;
};

@Injectable()
export class PlatformAdminAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Password check only. Always burns a bcrypt compare so unknown emails cost the same. */
  private async authenticate(email: unknown, password: unknown): Promise<AdminRow> {
    const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const admin = normalised
      ? ((await this.prisma.adminUser.findUnique({
          where: { email: normalised },
          select: {
            id: true,
            email: true,
            role: true,
            passwordHash: true,
            mfaEnabled: true,
            mfaSecret: true,
          },
        })) as AdminRow | null)
      : null;

    const ok = await bcrypt.compare(
      typeof password === 'string' ? password : '',
      admin?.passwordHash ?? DUMMY_HASH,
    );
    if (!admin || !admin.passwordHash || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return admin;
  }

  /**
   * Checks the code AND spends it, atomically (finding 11). The replay guard is the
   * row, not a module-level Map: it survives a restart or a deploy inside the code's
   * 90-second window, and it is shared by every replica. The conditional updateMany
   * is the whole guard — two concurrent requests presenting the same code race on the
   * same row and exactly one of them matches, so `count === 1` means "this request is
   * the one that spent it".
   */
  private async spendTotp(admin: AdminRow, totp: unknown): Promise<boolean> {
    const step = matchTotpStep(admin, totp);
    if (step === null) return false;
    const { count } = await this.prisma.adminUser.updateMany({
      where: { id: admin.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return count === 1;
  }

  /**
   * §9A.2: MFA is mandatory, so there is exactly one path to a platform session
   * and it runs through spendTotp. No `if (mfaEnabled)` branch exists — an
   * admin who has not enrolled cannot log in at all, they can only enrol.
   */
  async login(
    email: unknown,
    password: unknown,
    totp: unknown,
  ): Promise<{ token: string; session: PlatformSession }> {
    const admin = await this.authenticate(email, password);

    if (!admin.mfaEnabled) {
      // Only reachable once the password is already correct, so this reveals
      // nothing to someone who does not already have the credential.
      throw new ForbiddenException({
        code: 'MFA_ENROLMENT_REQUIRED',
        message: 'MFA enrolment is required before this account can sign in.',
      });
    }
    if (!(await this.spendTotp(admin, totp))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    // Note the shape: adminUserId, role, scope. No organizationId is available
    // to pass, so none can be smuggled in.
    const session: PlatformSession = {
      adminUserId: admin.id,
      role: admin.role,
      scope: 'PLATFORM',
    };
    return { token: await signPlatformSession({ adminUserId: admin.id, role: admin.role }), session };
  }

  /** Step 1 of enrolment: password-gated, returns the secret + otpauth:// URI. */
  async beginMfaEnrolment(
    email: unknown,
    password: unknown,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const admin = await this.authenticate(email, password);
    if (admin.mfaEnabled) {
      throw new ForbiddenException('MFA is already enrolled for this account.');
    }
    // The pending secret is stored now so step 2 can verify against it. mfaEnabled
    // stays false until then, so a stored-but-unconfirmed secret grants nothing.
    const { secret, otpauthUri, encryptedSecret } = newSecret(admin.email);
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      // mfaLastStep is cleared with the secret: steps spent against the old one
      // say nothing about the new one, and leaving it could reject a valid
      // confirmation code landing in the same step.
      data: { mfaSecret: encryptedSecret, mfaLastStep: null },
    });
    return { secret, otpauthUri };
  }

  /** Step 2: prove possession of the authenticator, then flip mfaEnabled. */
  async confirmMfaEnrolment(email: unknown, password: unknown, totp: unknown): Promise<void> {
    const admin = await this.authenticate(email, password);
    if (admin.mfaEnabled) {
      throw new ForbiddenException('MFA is already enrolled for this account.');
    }
    if (!(await this.spendTotp(admin, totp))) {
      throw new UnauthorizedException('Invalid code');
    }
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
    });
  }
}
