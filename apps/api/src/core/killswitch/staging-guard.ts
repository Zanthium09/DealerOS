// §12.7 — "the most common way a careful system still causes damage is a test run
// against production credentials." A code-level guard, not a config setting: outside
// NODE_ENV=production, a send to anything that isn't a recognised test destination is
// refused, unconditionally, regardless of what secrets happen to be loaded.
//
// Defaults need no configuration to be safe out of the box: Meta's own WhatsApp test
// numbers live under +1 555, and example.com/.org/.net, the bare .example TLD, and
// test.local are all IANA/RFC 2606 reserved for exactly this — 'sharmatraders.example'
// is as reserved as 'sharmatraders.example.com'. Real dealer addresses never match.
const DEFAULT_TEST_PHONE_PREFIXES = ['+1555'];
const DEFAULT_TEST_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'example', 'test.local'];

function testPhonePrefixes(): string[] {
  const env = process.env.STAGING_TEST_PHONE_PREFIXES;
  return env ? env.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TEST_PHONE_PREFIXES;
}

function testEmailDomains(): string[] {
  const env = process.env.STAGING_TEST_EMAIL_DOMAINS;
  return env
    ? env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_TEST_EMAIL_DOMAINS;
}

export class StagingSendBlockedError extends Error {
  constructor(destination: string) {
    super(
      `refusing to send to "${destination}" outside production (§12.7) — ` +
        `not a recognised test destination`,
    );
    this.name = 'StagingSendBlockedError';
  }
}

export type SendDestination = { phoneE164?: string | null; email?: string | null };

/**
 * Call this before any real send. In production it is a no-op — sending to real
 * dealers is the entire point there. Everywhere else, it throws unless every
 * destination given is a recognised test one.
 */
export function assertSendAllowed(dest: SendDestination): void {
  if (process.env.NODE_ENV === 'production') return;

  if (dest.phoneE164) {
    const ok = testPhonePrefixes().some((prefix) => dest.phoneE164!.startsWith(prefix));
    if (!ok) throw new StagingSendBlockedError(dest.phoneE164);
  }
  if (dest.email) {
    const domain = dest.email.toLowerCase().split('@')[1] ?? '';
    const ok = testEmailDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
    if (!ok) throw new StagingSendBlockedError(dest.email);
  }
}
