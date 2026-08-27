import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { HttpRequest, readCookie } from './http';
import { TENANT_COOKIE, TenantSession, verifyTenantSession } from './tenant-session';

/**
 * Accepts tenant session tokens and nothing else (§9A.2, §10.8).
 *
 * There is no code path in this guard that reads a `scope` claim, no branch that
 * treats any value as "cross-org", and no way for it to attach a session without
 * an organizationId. A platform token fails at signature verification before any
 * of its claims are even looked at, because the two flows sign with different
 * secrets.
 */
@Injectable()
export class TenantAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const token = readCookie(req, TENANT_COOKIE);
    if (!token) throw new UnauthorizedException('Not authenticated');

    const session = await verifyTenantSession(token);
    if (!session) throw new UnauthorizedException('Not authenticated');

    req.tenantSession = session;
    return true;
  }
}

/** What the tenancy layer (§1.3) reads. Always carries an organizationId. */
export const CurrentTenantSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantSession =>
    context.switchToHttp().getRequest<HttpRequest>().tenantSession as TenantSession,
);
