// Minimal HTTP shims for the platform admin flow. Deliberately a separate copy
// from core/auth/http.ts (§9A.2 — no shared code path between the two flows).

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  /** Parsed by express before guards run. The login rate limiter keys on body.email. */
  body?: unknown;
  // populated by the guard
  platformSession?: unknown;
}

export interface HttpResponse {
  setHeader(name: string, value: string | string[]): void;
}

export function readCookie(req: HttpRequest, name: string): string | null {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Finding 9: this used to be `NODE_ENV === 'production' ? '; Secure' : ''` — the
// exact NODE_ENV gate the session-secret code in this same codebase deliberately
// refuses. A deploy that forgets NODE_ENV shipped session cookies without Secure.
// Inverted: Secure is the default and ALLOW_DEV_SECRETS=1 is the only way off it,
// which is the same opt-in switch that governs the dev secret fallbacks.
function insecureCookiesAllowed(): boolean {
  return process.env.ALLOW_DEV_SECRETS === '1';
}

export function setSessionCookie(
  res: HttpResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  const secure = insecureCookiesAllowed() ? '' : '; Secure';
  // Strict, not Lax: the admin app is its own origin and never linked to from
  // a tenant-facing page.
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

export function clearSessionCookie(res: HttpResponse, name: string): void {
  const secure = insecureCookiesAllowed() ? '' : '; Secure';
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

export function clientIp(req: HttpRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
