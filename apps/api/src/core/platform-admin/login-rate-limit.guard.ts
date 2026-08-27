import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { HttpRequest, clientIp } from './http';

// ponytail: in-memory fixed window, per process. Move to Redis (§2) when the API
// runs more than one replica. Separate copy from the tenant flow's limiter on
// purpose (§9A.2), and tighter — a handful of operators, not a whole tenant base.
const WINDOW_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

@Injectable()
export class PlatformLoginRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const key = clientIp(req);
    const now = Date.now();
    const maxAttempts = Number(process.env.ADMIN_LOGIN_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS;

    if (this.hits.size > 10_000) this.hits.clear();

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
}
