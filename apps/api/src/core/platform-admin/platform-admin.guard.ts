import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { HttpRequest, readCookie } from './http';
import { PLATFORM_COOKIE, PlatformSession, verifyPlatformSession } from './platform-session';

/**
 * Accepts platform admin session tokens and nothing else (§9A.2).
 *
 * A tenant token fails signature verification here — the two flows sign with
 * different secrets — so it is rejected before its role claim is ever read.
 * That is why no User.role value can reach a platform route: the rejection is
 * cryptographic, not a role check that someone could later widen.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const token = readCookie(req, PLATFORM_COOKIE);
    if (!token) throw new UnauthorizedException('Not authenticated');

    const session = await verifyPlatformSession(token);
    if (!session) throw new UnauthorizedException('Not authenticated');

    req.platformSession = session;
    return true;
  }
}

export const CurrentPlatformSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformSession =>
    context.switchToHttp().getRequest<HttpRequest>().platformSession as PlatformSession,
);
