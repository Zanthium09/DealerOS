// Tenant session tokens (§9A.1).
//
// Deliberately duplicated in spirit by core/platform-admin/platform-session.ts.
// §9A.2 says the two login flows must share no code path beyond the database
// connection, so there is no shared "session util" for both to import. The
// duplication IS the safety property — do not refactor these two files into one.
//
// Structural separation, in layers:
//   1. Different signing secret. A platform token cannot even verify here.
//   2. Different JWT audience.
//   3. A required `typ: 'tenant'` claim.
//   4. An explicit rejection of any PLATFORM scope claim.
import { SignJWT, jwtVerify } from 'jose';

const AUDIENCE = 'dealeros:tenant';
const ISSUER = 'dealeros';
export const TENANT_COOKIE = 'dos_session';

/** Short-lived (§13). No server-side session table exists, so TTL is the only revocation. */
export const TENANT_TOKEN_TTL_SECONDS = 15 * 60;

export interface TenantSession {
  userId: string;
  organizationId: string;
  role: string;
}

function secret(): Uint8Array {
  const raw = process.env.AUTH_SESSION_SECRET;
  if (!raw) {
    // Two independent refusals, because .env.example promises both and an operator
    // reads that file, not this one (finding 7).
    //   1. Production never gets the fallback, whatever ALLOW_DEV_SECRETS says —
    //      a copied .env cannot carry the dev switch into production.
    //   2. Absent ALLOW_DEV_SECRETS the fallback is refused whatever NODE_ENV says,
    //      so a deploy that forgets NODE_ENV still fails closed.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUTH_SESSION_SECRET is required in production. Refusing to start.');
    }
    if (process.env.ALLOW_DEV_SECRETS !== '1') {
      throw new Error(
        'AUTH_SESSION_SECRET is required. Set it, or set ALLOW_DEV_SECRETS=1 for local development only.',
      );
    }
    // ponytail: dev-only fallback so `pnpm dev` works with no .env edits.
    return new TextEncoder().encode('dev-only-tenant-session-secret-change-me');
  }
  if (raw.length < 32) throw new Error('AUTH_SESSION_SECRET must be >= 32 characters');
  return new TextEncoder().encode(raw);
}

export async function signTenantSession(s: TenantSession): Promise<string> {
  return new SignJWT({ typ: 'tenant', org: s.organizationId, role: s.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TENANT_TOKEN_TTL_SECONDS}s`)
    .sign(secret());
}

/** Returns null for anything that is not a valid tenant token. Never throws for bad input. */
export async function verifyTenantSession(token: string): Promise<TenantSession | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'tenant') return null;
    // A PLATFORM claim has no meaning here and must never be honoured (§9A.2, §10.8).
    if ('scope' in payload) return null;
    const { sub, org, role } = payload as { sub?: string; org?: unknown; role?: unknown };
    if (!sub || typeof org !== 'string' || !org || typeof role !== 'string') return null;
    return { userId: sub, organizationId: org, role };
  } catch {
    return null;
  }
}
