import * as bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { AdminRole, UserRole } from '@prisma/client';
import { Res, cookieValue, raw, req } from '../support';
import { TENANT_COOKIE } from '../../src/core/auth/tenant-session';
import { PLATFORM_COOKIE } from '../../src/core/platform-admin/platform-session';

export const TEST_PASSWORD = 'correct-horse-battery-staple';
/** Cost 4: these tests hash a lot and bcryptjs is pure JS. Production uses 12. */
export const hash = (v: string) => bcrypt.hashSync(v, 4);

let n = 0;
const uniq = (p: string) => `${p}-${(n += 1)}-${Date.now().toString(36)}`;

export async function makeOrg(slug = uniq('org')): Promise<string> {
  const org = await raw.organization.create({ data: { name: slug, slug } });
  return org.id;
}

export async function makeUser(organizationId: string, role: UserRole) {
  const email = `${uniq(role.toLowerCase())}@tenant.test`;
  const user = await raw.user.create({
    data: { organizationId, email, role, passwordHash: hash(TEST_PASSWORD) },
  });
  return { id: user.id, email, organizationId, role };
}

/**
 * A TOTP code for `secret`, optionally at a shifted time. The server accepts one step
 * either side of now and refuses a replayed code, so a test that has just spent the
 * current step (enrolment) asks for the next one instead of sleeping 30 seconds.
 */
export function code(secret: string, atOffsetMs = 0): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({ timestamp: Date.now() + atOffsetMs });
}

export const STEP_MS = 30_000;

/** An AdminUser that exists but has not enrolled: password-correct logins get 403. */
export async function makeAdmin(role: AdminRole = 'PLATFORM_ADMIN') {
  const email = `${uniq('admin')}@platform.test`;
  const admin = await raw.adminUser.create({
    data: { email, role, passwordHash: hash(TEST_PASSWORD) },
  });
  return { id: admin.id, email, role };
}

/** An enrolled AdminUser, enrolled through the real two-step flow. */
export async function makeEnrolledAdmin(base: string, role: AdminRole = 'PLATFORM_ADMIN') {
  const admin = await makeAdmin(role);
  const enrol = await req(base, 'POST', '/admin/auth/mfa/enrol', {
    body: { email: admin.email, password: TEST_PASSWORD },
  });
  const secret: string = enrol.body.secret;
  await req(base, 'POST', '/admin/auth/mfa/confirm', {
    body: { email: admin.email, password: TEST_PASSWORD, totp: code(secret) },
  });
  return { ...admin, secret };
}

export async function tenantLogin(
  base: string,
  email: string,
): Promise<{ res: Res; token: string }> {
  const res = await req(base, 'POST', '/auth/login', { body: { email, password: TEST_PASSWORD } });
  return { res, token: cookieValue(res, TENANT_COOKIE) ?? '' };
}

export async function adminLogin(
  base: string,
  admin: { email: string; secret: string },
  offsetMs = STEP_MS,
): Promise<{ res: Res; token: string }> {
  const res = await req(base, 'POST', '/admin/auth/login', {
    body: { email: admin.email, password: TEST_PASSWORD, totp: code(admin.secret, offsetMs) },
  });
  return { res, token: cookieValue(res, PLATFORM_COOKIE) ?? '' };
}
