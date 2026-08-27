import { Injectable, NestMiddleware } from '@nestjs/common';
import { TENANT_COOKIE, readCookie, verifyTenantSession } from '../auth';
import { runWithOrg } from './tenancy';

// Wraps the whole request in the org context so every query underneath it is scoped.
// It must wrap `next()` itself — Prisma promises resolve lazily, so a context that ends
// before the handler awaits is no context at all (see the test of the same name).
//
// §9A.1: the organizationId comes from the verified tenant session and NOWHERE ELSE.
// There used to be an `x-organization-id` header path here; it was a tenant-switching
// hole — any caller could name any org — and it is deleted, not flagged, not behind a
// flag. If you are adding a way to set the org from the request again, you are
// reintroducing that hole.
//
// §9A.2: a platform session is not handled here and deliberately produces no org
// context. Platform requests go to /admin/* with their own guard.
//
// No session, no context — and no exception either: fail-closed lives in tenancy.ts,
// where an unscoped query throws. Throwing here instead would 401 the login route.
@Injectable()
export class TenancyMiddleware implements NestMiddleware {
  async use(
    req: { headers: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void,
  ) {
    const token = readCookie(req, TENANT_COOKIE);
    const session = token ? await verifyTenantSession(token) : null;
    if (!session) return next();
    runWithOrg(session.organizationId, next);
  }
}
