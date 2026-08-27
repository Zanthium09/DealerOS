import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { TenantSession, signTenantSession } from './tenant-session';

export const BCRYPT_COST = 12;

// Compared against when the email is unknown, so "no such user" and "wrong
// password" cost the same time and return the same message (no user
// enumeration, §13). Hashed at import so it is a genuinely valid bcrypt digest
// of a value nobody knows.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Tenant login. Returns a session bound to exactly one organizationId (§4).
   * There is no branch here that can produce a session without one, and no
   * User.role value changes what this returns beyond the role string itself.
   *
   * `organizationSlug` is optional: User email is unique per org, not globally,
   * so it is only needed when the same address exists in more than one tenant.
   */
  async login(
    email: unknown,
    password: unknown,
    organizationSlug?: unknown,
  ): Promise<{ token: string; session: TenantSession }> {
    const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const slug = typeof organizationSlug === 'string' && organizationSlug ? organizationSlug : null;

    const candidates = normalised
      ? await this.prisma.user.findMany({
          where: {
            email: normalised,
            ...(slug ? { organization: { slug } } : {}),
          },
          select: { id: true, organizationId: true, role: true, passwordHash: true },
          take: 2,
        })
      : [];

    // Ambiguous without a slug — refuse rather than guess which tenant they meant.
    const user = candidates.length === 1 ? candidates[0] : null;

    const ok = await bcrypt.compare(
      typeof password === 'string' ? password : '',
      user?.passwordHash ?? DUMMY_HASH,
    );

    if (!user || !user.passwordHash || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const session: TenantSession = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
    };
    return { token: await signTenantSession(session), session };
  }
}
