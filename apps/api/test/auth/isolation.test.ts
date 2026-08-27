// §9A.2 / §10.8 — the two flows must not be wirable together.
//
// Every test in this file is written so it FAILS if someone later merges the session
// modules, shares a signing secret, adds a `PLATFORM` branch to the tenant guard, or
// lets a User.role imply platform access.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import { Prisma, UserRole } from '@prisma/client';
import { bootApp, raw, req } from '../support';
import { STEP_MS, adminLogin, makeEnrolledAdmin, makeOrg, makeUser, tenantLogin } from './fixtures';
import { TENANT_COOKIE } from '../../src/core/auth/tenant-session';
import { PLATFORM_COOKIE } from '../../src/core/platform-admin/platform-session';

let app: INestApplication;
let base: string;
let orgId: string;
/** One user per role — every value the enum defines, not a chosen sample. */
const users = new Map<UserRole, { email: string; id: string }>();

before(async () => {
  ({ app, base } = await bootApp());
  orgId = await makeOrg('isolation');
  for (const role of Object.values(UserRole)) {
    users.set(role, await makeUser(orgId, role));
  }
});

after(async () => {
  await app.close();
  await raw.$disconnect();
});

describe('two-flow isolation (§9A.2, §10.8)', () => {
  test('a tenant token presented to an admin route is rejected', async () => {
    const { token } = await tenantLogin(base, users.get('OWNER')!.email);
    assert.ok(token);
    // Under the admin cookie name — so this cannot pass merely because the guard
    // looked at the wrong cookie...
    assert.equal(
      (await req(base, 'GET', '/admin/auth/session', { cookies: { [PLATFORM_COOKIE]: token } }))
        .status,
      401,
    );
    // ...and under its own name, in case someone later teaches the admin guard to
    // fall back to the tenant cookie.
    assert.equal(
      (await req(base, 'GET', '/admin/auth/session', { cookies: { [TENANT_COOKIE]: token } }))
        .status,
      401,
    );
  });

  test('an admin token presented to a tenant route is REFUSED, not re-scoped (§10.8)', async () => {
    const admin = await makeEnrolledAdmin(base);
    const { token } = await adminLogin(base, admin);
    assert.ok(token);

    const res = await req(base, 'GET', '/auth/session', { cookies: { [TENANT_COOKIE]: token } });
    assert.equal(res.status, 401);
    // Not "accepted but oddly scoped": no session body of any kind comes back, and
    // nothing about an organization appears in the response.
    assert.equal(res.body.user, undefined);
    assert.ok(!JSON.stringify(res.body ?? {}).includes(orgId));

    assert.equal(
      (await req(base, 'GET', '/auth/session', { cookies: { [PLATFORM_COOKIE]: token } })).status,
      401,
    );
  });

  test('the schema defines exactly the roles this file enumerates', () => {
    // Guards the loop below: a new role added to the enum lands here first, and
    // whoever added it is reminded that §1.9 still has to hold.
    assert.deepEqual(Object.values(UserRole).sort(), ['OFFICE_STAFF', 'OWNER', 'SALESMAN']);
    assert.deepEqual(
      Prisma.dmmf.datamodel.enums.find((e) => e.name === 'UserRole')?.values.map((v) => v.name),
      Object.values(UserRole),
    );
  });

  for (const role of Object.values(UserRole)) {
    test(`no User.role produces platform access: ${role}`, async () => {
      const { token } = await tenantLogin(base, users.get(role)!.email);

      // The tenant session is real and carries this role...
      const ok = await req(base, 'GET', '/auth/session', { cookies: { [TENANT_COOKIE]: token } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.user.role, role);
      assert.equal(ok.body.user.organizationId, orgId);

      // ...and it is worth nothing on a platform route, under either cookie name.
      for (const name of [PLATFORM_COOKIE, TENANT_COOKIE]) {
        assert.equal(
          (await req(base, 'GET', '/admin/auth/session', { cookies: { [name]: token } })).status,
          401,
        );
      }
    });
  }

  test('a PLATFORM session carries no organizationId and cannot acquire one', async () => {
    const admin = await makeEnrolledAdmin(base);
    const { token } = await adminLogin(base, admin);

    const res = await req(base, 'GET', '/admin/auth/session', {
      cookies: { [PLATFORM_COOKIE]: token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.admin.scope, 'PLATFORM');
    assert.equal(res.body.admin.organizationId, undefined);
    assert.ok(!JSON.stringify(res.body).includes(orgId));

    // The raw claims carry none either.
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.equal(claims.org, undefined);
    assert.equal(claims.organizationId, undefined);

    // And it cannot acquire one: naming an org in the request changes nothing.
    const nudged = await req(base, 'GET', '/admin/auth/session', {
      cookies: { [PLATFORM_COOKIE]: token },
      headers: { 'x-organization-id': orgId },
    });
    assert.deepEqual(nudged.body.admin, res.body.admin);
  });

  test('a PLATFORM token with an org claim bolted on is rejected by both guards', async () => {
    const forged = await new SignJWT({
      typ: 'admin',
      scope: 'PLATFORM',
      role: 'PLATFORM_ADMIN',
      org: orgId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin_forged')
      .setIssuer('dealeros')
      .setAudience('dealeros:platform')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(process.env.ADMIN_SESSION_SECRET as string));

    assert.equal(
      (await req(base, 'GET', '/admin/auth/session', { cookies: { [PLATFORM_COOKIE]: forged } }))
        .status,
      401,
    );
    assert.equal(
      (await req(base, 'GET', '/auth/session', { cookies: { [TENANT_COOKIE]: forged } })).status,
      401,
    );
  });

  test('a tenant-signed token claiming scope PLATFORM is rejected by both guards', async () => {
    const forged = await new SignJWT({
      typ: 'tenant',
      scope: 'PLATFORM',
      org: orgId,
      role: 'OWNER',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(users.get('OWNER')!.id)
      .setIssuer('dealeros')
      .setAudience('dealeros:tenant')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(process.env.AUTH_SESSION_SECRET as string));

    // The tenant guard refuses it rather than quietly ignoring the extra claim.
    assert.equal(
      (await req(base, 'GET', '/auth/session', { cookies: { [TENANT_COOKIE]: forged } })).status,
      401,
    );
    assert.equal(
      (await req(base, 'GET', '/admin/auth/session', { cookies: { [PLATFORM_COOKIE]: forged } }))
        .status,
      401,
    );
  });

  test('the two flows sign with different secrets', () => {
    assert.notEqual(process.env.AUTH_SESSION_SECRET, process.env.ADMIN_SESSION_SECRET);
  });

  test('an expired-window admin code is not a session (sanity on the TOTP window)', async () => {
    const admin = await makeEnrolledAdmin(base);
    const stale = await adminLogin(base, admin, -10 * STEP_MS);
    assert.equal(stale.res.status, 401);
  });
});
