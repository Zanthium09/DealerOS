import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { HttpRequest, clientIp } from './http';

// ponytail: in-memory fixed window, per process. Move to Redis (§2) when the API
// runs more than one replica. Separate copy from the tenant flow's limiter on
// purpose (§9A.2), and tighter — a handful of operators, not a whole tenant base.
const WINDOW_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

// Finding 8: the bucket key is the ACCOUNT, not req.ip.
//
// main.ts sets no `trust proxy`, so behind Railway/Render req.ip is the load
// balancer's address — identical for every request on the planet. An IP-keyed
// bucket was therefore ONE bucket for the whole platform: a handful of anonymous
// POSTs exhausted it and every real operator got 429, repeatable indefinitely.
// Keying on the account means a lockout costs the attacker one victim account.
//
// No enumeration: the key is whatever email the request carried, never looked up,
// so an unknown address gets a bucket and a 429 exactly like a real one, at the
// same cost. Requests with no email at all share one per-IP bucket — they cannot
// authenticate anyway, and they can no longer starve the named ones.
function bucketKey(req: HttpRequest): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof email === 'string' && email.trim()) {
    return `email:${email.trim().toLowerCase().slice(0, 254)}`;
  }
  return `ip:${clientIp(req)}`;
}

@Injectable()
export class PlatformLoginRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const key = bucketKey(req);
    const now = Date.now();
    const maxAttempts = Number(process.env.ADMIN_LOGIN_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS;

    if (this.hits.size > 10_000) this.sweepExpired(now);

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    entry.count += 1;
    if (entry.count > maxAttempts) {
      throw new HttpException({ message: 'Too many login attempts. Try again shortly.' }, 429);
    }
    return true;
  }

  // `this.hits.clear()` on overflow reset live lockouts: ~10k requests with distinct
  // emails flushed the victim's counter inside the same window (~1000:1 amplification),
  // and every other operator's with it. Expired entries only — never a live bucket.
  //
  // ponytail: bounded by distinct keys per 60s window rather than by a hard cap.
  // Redis (§2) when the API runs more than one replica.
  private sweepExpired(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
