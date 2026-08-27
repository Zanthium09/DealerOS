// Minimal HTTP shims for the tenant auth flow. Local on purpose (§9A.2 — no shared
// code path with the platform-admin flow). Also keeps this module independent of
// app bootstrap: no cookie-parser, no global pipes, nothing to wire in main.ts.

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  // populated by the guard
  tenantSession?: unknown;
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
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

export function clearSessionCookie(res: HttpResponse, name: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export function clientIp(req: HttpRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
