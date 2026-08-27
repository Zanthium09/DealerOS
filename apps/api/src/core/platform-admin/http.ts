// Minimal HTTP shims for the platform admin flow. Deliberately a separate copy
// from core/auth/http.ts (§9A.2 — no shared code path between the two flows).

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
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

export function setSessionCookie(
  res: HttpResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // Strict, not Lax: the admin app is its own origin and never linked to from
  // a tenant-facing page.
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

export function clearSessionCookie(res: HttpResponse, name: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

export function clientIp(req: HttpRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
