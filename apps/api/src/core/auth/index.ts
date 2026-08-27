// Public surface of the tenant auth flow. The tenancy layer (§1.3) needs
// TenantAuthGuard + CurrentTenantSession + the TenantSession shape; nothing else
// outside this directory should reach in.
export { AuthModule } from './auth.module';
export { AuthService, BCRYPT_COST } from './auth.service';
export { TenantAuthGuard, CurrentTenantSession } from './tenant-auth.guard';
export { TENANT_COOKIE, TENANT_TOKEN_TTL_SECONDS, verifyTenantSession } from './tenant-session';
// The tenancy middleware (§9A.1) reads the org from the verified session, which means
// reading this flow's cookie. Nothing else outside this directory should need these.
export { readCookie } from './http';
export type { TenantSession } from './tenant-session';
