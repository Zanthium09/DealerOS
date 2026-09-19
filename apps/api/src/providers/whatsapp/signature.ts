import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(app secret,
 * raw body)>`. Constant-time comparison, and a missing/short/malformed header is simply
 * "does not verify" — never an exception that leaks which part was wrong.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const given = header.startsWith('sha256=') ? header.slice('sha256='.length) : '';
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
