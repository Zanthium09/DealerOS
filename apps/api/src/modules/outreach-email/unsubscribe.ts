import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * §6 — "working one-click unsubscribe on every email (List-Unsubscribe header + link)".
 * The link needs no login (a dealer clicking it is not a session holder), so it
 * carries a signed, unguessable token rather than a bare dealerId — anyone who could
 * guess a dealerId could otherwise opt another business out of email.
 */
export function unsubscribeToken(secret: string, organizationId: string, dealerId: string): string {
  const payload = `${organizationId}.${dealerId}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}

export function verifyUnsubscribeToken(
  secret: string,
  token: string,
): { organizationId: string; dealerId: string } | null {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [organizationId, dealerId] = payload.split('.');
  if (!organizationId || !dealerId) return null;
  return { organizationId, dealerId };
}

export function unsubscribeUrl(baseUrl: string, secret: string, organizationId: string, dealerId: string): string {
  return `${baseUrl}/outreach-email/unsubscribe?token=${unsubscribeToken(secret, organizationId, dealerId)}`;
}

/** §6 — both the header (what mail clients act on) and the link (what a human clicks). */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
