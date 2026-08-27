import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import * as OTPAuth from 'otpauth';

// §9A.2: MFA is mandatory on the platform admin login.
//
// The secret is generated per admin, stored on AdminUser.mfaSecret, and encrypted at
// rest with AES-256-GCM under a key derived from ADMIN_MFA_KEY. Two consequences that
// are the whole point:
//   * one admin's factor can be reset or rotated without touching anyone else's;
//   * a database dump on its own yields no working second factors — the ciphertext is
//     useless without ADMIN_MFA_KEY, which lives in the environment, not the database.
// (The previous version derived every secret from ADMIN_MFA_KEY alone: no rotation,
// and one key compromised every admin at once.)

const PERIOD = 30;
const DIGITS = 6;
/** Accept the previous, current and next step — normal clock-skew tolerance. */
const WINDOW = 1;

export type AdminTotpIdentity = {
  id: string;
  email: string;
  /** Ciphertext from `newSecret()`. */
  mfaSecret: string | null;
};

function mfaKey(): Buffer {
  const raw = process.env.ADMIN_MFA_KEY;
  if (!raw) {
    // Fail closed: the dev fallback is opt-in, never implied by NODE_ENV.
    // A deploy that forgets NODE_ENV must NOT silently use a secret published in git.
    if (process.env.ALLOW_DEV_SECRETS !== '1') {
      throw new Error(
        'ADMIN_MFA_KEY is required. Set it, or set ALLOW_DEV_SECRETS=1 for local development only.',
      );
    }
    // ponytail: dev-only fallback so `pnpm dev` works with no .env edits.
    return deriveKey('dev-only-admin-mfa-encryption-key-change-me');
  }
  if (raw.length < 32) throw new Error('ADMIN_MFA_KEY must be >= 32 characters');
  return deriveKey(raw);
}

function deriveKey(raw: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(raw, 'utf8'), Buffer.alloc(0), 'dealeros:admin:totp:v2', 32),
  );
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix makes a key or
 *  algorithm change a migration someone can actually write. */
function encryptSecret(base32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mfaKey(), iv);
  const ct = Buffer.concat([cipher.update(base32, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

function decryptSecret(blob: string): string {
  const [version, iv, tag, ct] = blob.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('mfaSecret is not a v1 blob');
  const decipher = createDecipheriv('aes-256-gcm', mfaKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function totpFor(base32: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'DealerOS Platform',
    label: email,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(base32),
  });
}

/**
 * Enrolment payload: the base32 secret and otpauth:// URI for the operator's
 * authenticator, plus the ciphertext to store on AdminUser.mfaSecret. The plaintext
 * is returned once, at enrolment, and never read back out of the database.
 */
export function newSecret(email: string): {
  secret: string;
  otpauthUri: string;
  encryptedSecret: string;
} {
  const secret = new OTPAuth.Secret({ size: 20 }).base32; // 160 bits, RFC 4226
  return {
    secret,
    otpauthUri: totpFor(secret, email).toString(),
    encryptedSecret: encryptSecret(secret),
  };
}

// ponytail: single-process replay guard — the last accepted step per admin, in memory.
// Ceiling: a second API replica has its own map, so a code replayed against the other
// replica within its 90-second window would pass. Move to Redis (already in §2's stack)
// when the API runs more than one instance.
const lastAcceptedStep = new Map<string, number>();

/**
 * Constant-time TOTP check across the accepted window. otpauth's own `validate`
 * short-circuits; this does not. A code is accepted at most once per admin: replaying
 * the same code inside its validity window is rejected.
 */
export function verifyTotp(admin: AdminTotpIdentity, code: unknown): boolean {
  if (!admin.mfaSecret) return false;
  if (typeof code !== 'string') return false;
  const candidate = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;

  let totp: OTPAuth.TOTP;
  try {
    totp = totpFor(decryptSecret(admin.mfaSecret), admin.email);
  } catch {
    return false; // wrong key, tampered ciphertext, or a pre-v1 value
  }

  const provided = Buffer.from(candidate, 'utf8');
  const now = Date.now();
  const currentStep = Math.floor(now / 1000 / PERIOD);

  let matchedStep: number | null = null;
  for (let step = -WINDOW; step <= WINDOW; step += 1) {
    const expected = Buffer.from(totp.generate({ timestamp: now + step * PERIOD * 1000 }), 'utf8');
    // Lengths are both DIGITS by construction, so timingSafeEqual cannot throw.
    if (timingSafeEqual(expected, provided)) matchedStep = currentStep + step;
  }
  if (matchedStep === null) return false;

  const seen = lastAcceptedStep.get(admin.id);
  if (seen !== undefined && matchedStep <= seen) return false; // replay
  if (lastAcceptedStep.size > 10_000) lastAcceptedStep.clear();
  lastAcceptedStep.set(admin.id, matchedStep);
  return true;
}
