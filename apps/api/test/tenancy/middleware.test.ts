// §9A.1 — the request's organization comes from the verified tenant session and
// nowhere else. `x-organization-id` used to choose the tenant; anyone could send it.
// These tests fail if that header (or any other request-supplied org) comes back.
import '../support';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
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

  test('a forged or expired token yields no context, not a chosen one', async () => {
    assert.equal(await contextFor({ cookie: `${TENANT_COOKIE}=not.a.jwt` }), undefined);
    const wrongSecret = await signTenantSession({
      userId: 'u1',
      organizationId: 'org-victim',
      role: 'OWNER',
    });
    // Same token under the admin cookie name: the middleware does not read that cookie.
    assert.equal(await contextFor({ cookie: `dos_admin_session=${wrongSecret}` }), undefined);
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
