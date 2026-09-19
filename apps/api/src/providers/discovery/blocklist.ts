// §5.0 / §10.10 / design doc §2.1 — enforced in code, before any fetch.
//
// IndiaMART, JustDial and TradeIndia forbid automated access in their terms. The list is
// configuration (DISCOVERY_BLOCKLIST, comma-separated, added to the defaults) so it can
// grow without a deploy. A blocked domain is an answer, not an obstacle: the run is
// REFUSED and the user is told to open the page themselves and enter the dealer by hand.

export const DEFAULT_BLOCKLIST = ['indiamart.com', 'justdial.com', 'tradeindia.com'];

export function blocklist(env: string | undefined = process.env.DISCOVERY_BLOCKLIST): string[] {
  const extra = (env ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return [...new Set([...DEFAULT_BLOCKLIST, ...extra])];
}

/**
 * Parses what a person pasted. A scheme-less "indiamart.com/x" is read as https — it
 * must still hit the blocklist, and rejecting it as "not a URL" would be a way around it.
 * Only http(s) is ever fetchable; file:, ftp:, javascript: and the like return null.
 */
export function parseFetchableUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/** Lowercased, no trailing dot ("indiamart.com." is the same host). */
export function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.+$/, '');
}

/**
 * Host equals a blocked domain or is a subdomain of one. Matched on the parsed host, not
 * the string: "evil.com/indiamart.com", "indiamart.com.evil.com" and
 * "https://indiamart.com@evil.com" are NOT blocked (they are not that site), while
 * "https://evil.com@indiamart.com" IS (the host is indiamart.com).
 */
export function isBlocklisted(raw: string, list: string[] = blocklist()): boolean {
  const url = parseFetchableUrl(raw);
  if (!url) return false; // not fetchable at all — the caller refuses it on its own
  const host = hostnameOf(url);
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}
