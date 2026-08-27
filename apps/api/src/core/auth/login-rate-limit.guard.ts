import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { HttpRequest, clientIp } from './http';

// ponytail: in-memory fixed window, per process. Fine for one API instance;
// move to Redis (already in §2's stack) when the API runs more than one replica.
// Local to the tenant flow on purpose — the admin flow has its own copy (§9A.2).
const WINDOW_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;

@Injectable()
export class TenantLoginRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const key = clientIp(req);
    const now = Date.now();
    const maxAttempts = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS;

    if (this.hits.size > 10_000) this.hits.clear(); // crude unbounded-growth guard

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    entry.count += 1;
    if (entry.count > maxAttempts) {
      throw new HttpException(
        { message: 'Too many login attempts. Try again shortly.' },
        429,
      );
    }
    return true;
  }
}
