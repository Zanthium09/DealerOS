// §9A.1 — the request's organization comes from the verified tenant session and
// nowhere else. `x-organization-id` used to choose the tenant; anyone could send it.
// These tests fail if that header (or any other request-supplied org) comes back.
import '../support';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { SignJWT } from 'jose';
import { TenancyMiddleware } from '../../src/core/tenancy/tenancy.middleware';
import { getOrgId } from '../../src/core/tenancy/tenancy';
import { TENANT_COOKIE, signTenantSession } from '../../src/core/auth/tenant-session';

const middleware = new TenancyMiddleware();

/** Runs the middleware and reports the org context its `next()` saw. */
async function contextFor(headers: Record<string, string>): Promise<string | undefined> {
  let seen: string | undefined;
  await middleware.use({ headers }, {}, () => {
    seen = getOrgId();
  });
  return seen;
}

const session = (organizationId: string) =>
  signTenantSession({ userId: 'u1', organizationId, role: 'OWNER' });

describe('tenancy middleware takes the org from the session only (§9A.1)', () => {
  test('the x-organization-id header scopes nothing', async () => {
    assert.equal(await contextFor({ 'x-organization-id': 'org-victim' }), undefined);
  });

  test('a session sets the context', async () => {
    const token = await session('org-real');
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=${token}` }), 'org-real');
  });

  test('the header cannot override the session', async () => {
    const token = await session('org-real');
    const seen = await contextFor({
      cookie: `${TENANT_COOKIE}=${token}`,
      'x-organization-id': 'org-victim',
    });
    assert.equal(seen, 'org-real');
  });

  // Finding 10: this test used to sign its "forged" token with signTenantSession —
  // i.e. with the CORRECT secret — and never built an expired one at all. The only
  // thing actually rejected was the string 'not.a.jwt'. These are the real articles:
  // a token an attacker could mint with their own key, and one whose exp has passed.
  // Both are built with jose directly, so nothing here can accidentally reach for
  // the server's key again.
  const forge = (secretText: string, expiresAt: string | number) =>
    new SignJWT({ typ: 'tenant', org: 'org-victim', role: 'OWNER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('dealeros')
      .setAudience('dealeros:tenant')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(secretText));

  test('a garbage token yields no context', async () => {
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=not.a.jwt` }), undefined);
  });

  test('a token signed with a different secret yields no context', async () => {
    // Structurally perfect: right claims, right issuer, right audience, unexpired.
    // Only the signing key differs, which is the entire point of §9A.2's separation.
    const token = await forge('an-attackers-own-secret-0123456789abcdef', '15m');
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=${token}` }), undefined);
  });

  test('the admin session secret does not verify a tenant token either', async () => {
    const token = await forge(process.env.ADMIN_SESSION_SECRET as string, '15m');
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=${token}` }), undefined);
  });

  test('an expired token yields no context', async () => {
    // Correct secret, correct everything — exp is 60 seconds in the past. TTL is the
    // only revocation this system has (tenant-session.ts), so this is the assertion
    // that TTL means anything.
    const token = await forge(
      process.env.AUTH_SESSION_SECRET as string,
      Math.floor(Date.now() / 1000) - 60,
    );
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=${token}` }), undefined);
    // And the same token, unexpired, WOULD have set the context — so the rejection
    // above is exp doing the work, not some other claim being wrong.
    const live = await forge(process.env.AUTH_SESSION_SECRET as string, '15m');
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=${live}` }), 'org-victim');
  });

  test('a valid token under the admin cookie name yields no context', async () => {
    const token = await session('org-real');
    // The middleware does not read dos_admin_session.
    assert.equal(await contextFor({ cookie: `dos_admin_session=${token}` }), undefined);
  });

  test('the header path is gone from the source, not merely unused', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/core/tenancy/tenancy.middleware.ts'),
      'utf8',
    );
    // Named once, in the comment explaining why it must never come back.
    assert.equal(src.toLowerCase().split('x-organization-id').length - 1, 1);
    assert.ok(!/req\.headers\[['"]x-organization-id/i.test(src));
  });
});
