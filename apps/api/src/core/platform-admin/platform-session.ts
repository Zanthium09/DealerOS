// Platform admin session tokens (§9A.2).
//
// Intentionally NOT shared with core/auth/tenant-session.ts. §9A.2 requires the
// two flows to share no code path beyond the database connection. Merging these
// two files is the exact refactor that would reintroduce §10.8.
//
// A PLATFORM session has no organizationId and no way to acquire one: the type
// has no such field, the signer never writes one, and the verifier rejects any
// token that carries one.
import { SignJWT, jwtVerify } from 'jose';

const AUDIENCE = 'dealeros:platform';
const ISSUER = 'dealeros';
export const PLATFORM_COOKIE = 'dos_admin_session';

/** Shorter than the tenant TTL — this session can read every tenant's data (§9A.3). */
export const PLATFORM_TOKEN_TTL_SECONDS = 10 * 60;

export interface PlatformSession {
  adminUserId: string;
  role: string;
  scope: 'PLATFORM';
}

function secret(): Uint8Array {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw) {
    // Fail closed: the dev fallback is opt-in, never implied by NODE_ENV.
    // A deploy that forgets NODE_ENV must NOT silently use a secret published in git.
    if (process.env.ALLOW_DEV_SECRETS !== '1') {
      throw new Error(
        'ADMIN_SESSION_SECRET is required. Set it, or set ALLOW_DEV_SECRETS=1 for local development only.',
      );
    }
    // ponytail: dev-only fallback. Must differ from the tenant secret — that
    // difference is what makes a token from one flow unverifiable by the other.
    return new TextEncoder().encode('dev-only-platform-session-secret-change-me');
  }
  if (raw.length < 32) throw new Error('ADMIN_SESSION_SECRET must be >= 32 characters');
  return new TextEncoder().encode(raw);
}

export async function signPlatformSession(s: {
  adminUserId: string;
  role: string;
}): Promise<string> {
  // No org claim is written. There is no parameter here that could supply one.
  return new SignJWT({ typ: 'admin', scope: 'PLATFORM', role: s.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.adminUserId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${PLATFORM_TOKEN_TTL_SECONDS}s`)
    .sign(secret());
}

/** Returns null for anything that is not a valid platform token. Never throws. */
export async function verifyPlatformSession(token: string): Promise<PlatformSession | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'admin') return null;
    if (payload.scope !== 'PLATFORM') return null;
    // Belt and braces: a platform session must never carry an org (§9A.2).
    if ('org' in payload || 'organizationId' in payload) return null;
    const { sub, role } = payload as { sub?: string; role?: unknown };
    if (!sub || typeof role !== 'string') return null;
    return { adminUserId: sub, role, scope: 'PLATFORM' };
  } catch {
    return null;
  }
}
