// Login/logout/session behaviour for both flows, plus the §13 security rules:
// no user enumeration, mandatory MFA, TOTP correctness and replay, rate limiting,
// cookie flags. Real app, real database, node:test + fetch.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { bootApp, cookieValue, raw, req } from '../support';
import {
  STEP_MS,
  TEST_PASSWORD,
  adminLogin,
  code,
  hash,
  makeAdmin,
  makeEnrolledAdmin,
  makeOrg,
  makeUser,
  tenantLogin,
} from './fixtures';
import { TENANT_COOKIE } from '../../src/core/auth/tenant-session';
import { PLATFORM_COOKIE } from '../../src/core/platform-admin/platform-session';

let app: INestApplication;
let base: string;
let orgId: string;
let owner: { email: string; id: string };

before(async () => {
  ({ app, base } = await bootApp());
  orgId = await makeOrg('acme');
  owner = await makeUser(orgId, 'OWNER');
});

after(async () => {
  await app.close();
  await raw.$disconnect();
});

describe('tenant auth (/auth/*)', () => {
  test('logs in and returns a session scoped to one organization', async () => {
    const res = await req(base, 'POST', '/auth/login', {
      body: { email: ` ${owner.email.toUpperCase()} `, password: TEST_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user, { userId: owner.id, organizationId: orgId, role: 'OWNER' });

    const setCookie = res.cookies.join(';');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, new RegExp(`${TENANT_COOKIE}=`));
  });

  test('/auth/session requires a session', async () => {
    assert.equal((await req(base, 'GET', '/auth/session')).status, 401);
  });

  test('a valid session is accepted', async () => {
    const { token } = await tenantLogin(base, owner.email);
    const res = await req(base, 'GET', '/auth/session', { cookies: { [TENANT_COOKIE]: token } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.organizationId, orgId);
  });

  test('logout clears the cookie', async () => {
    const out = await req(base, 'POST', '/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.cookies.join(';'), /Max-Age=0/);
  });

  test('gives the same message for an unknown email and a wrong password (§13)', async () => {
    const unknown = await req(base, 'POST', '/auth/login', {
      body: { email: 'nobody@acme.test', password: TEST_PASSWORD },
    });
    const wrong = await req(base, 'POST', '/auth/login', {
      body: { email: owner.email, password: 'wrong' },
    });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, unknown.status);
    assert.equal(unknown.body.message, 'Invalid email or password');
    assert.equal(wrong.body.message, unknown.body.message);
    // Nothing in the body distinguishes the two cases either.
    assert.deepEqual(Object.keys(wrong.body).sort(), Object.keys(unknown.body).sort());
  });

  test('refuses an ambiguous email rather than guessing the tenant', async () => {
    const a = await makeOrg('shared-a');
    const b = await makeOrg('shared-b');
    for (const organizationId of [a, b]) {
      await raw.user.create({
        data: {
          organizationId,
          email: 'shared@both.test',
          role: 'OWNER',
          passwordHash: hash(TEST_PASSWORD),
        },
      });
    }

    const ambiguous = await req(base, 'POST', '/auth/login', {
      body: { email: 'shared@both.test', password: TEST_PASSWORD },
    });
    assert.equal(ambiguous.status, 401);

    const slug = (await raw.organization.findUniqueOrThrow({ where: { id: b } })).slug;
    const resolved = await req(base, 'POST', '/auth/login', {
      body: { email: 'shared@both.test', password: TEST_PASSWORD, organizationSlug: slug },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.user.organizationId, b);
  });

  test('rejects a garbage token', async () => {
    const res = await req(base, 'GET', '/auth/session', {
      cookies: { [TENANT_COOKIE]: 'not.a.jwt' },
    });
    assert.equal(res.status, 401);
  });

  test('rate limits repeated login attempts', async () => {
    // Its own app: the limiter is per instance, and this test deliberately fills it.
    const fresh = await bootApp();
    const prev = process.env.AUTH_LOGIN_MAX_ATTEMPTS;
    process.env.AUTH_LOGIN_MAX_ATTEMPTS = '3';
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push(
          (
            await req(fresh.base, 'POST', '/auth/login', {
              body: { email: owner.email, password: 'wrong' },
            })
          ).status,
        );
      }
      assert.ok(codes.filter((c) => c === 429).length > 0, `no 429 in ${codes}`);
      // And it is the limiter talking, not a lucky 401.
      assert.equal(codes[codes.length - 1], 429);
    } finally {
      process.env.AUTH_LOGIN_MAX_ATTEMPTS = prev;
      await fresh.app.close();
    }
  });
});

describe('platform admin auth (/admin/auth/*)', () => {
  test('MFA is mandatory — correct password alone is not enough (§9A.2)', async () => {
    const admin = await makeEnrolledAdmin(base);
    const noCode = await req(base, 'POST', '/admin/auth/login', {
      body: { email: admin.email, password: TEST_PASSWORD },
    });
    assert.equal(noCode.status, 401);
    const wrongCode = await req(base, 'POST', '/admin/auth/login', {
      body: { email: admin.email, password: TEST_PASSWORD, totp: '000000' },
    });
    assert.equal(wrongCode.status, 401);
  });

  test('logs in with password + current TOTP and records lastLoginAt', async () => {
    const admin = await makeEnrolledAdmin(base);
    const { res } = await adminLogin(base, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.admin, {
      adminUserId: admin.id,
      role: 'PLATFORM_ADMIN',
      scope: 'PLATFORM',
    });
    assert.match(res.cookies.join(';'), /SameSite=Strict/);

    const row = await raw.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
    assert.ok(row.lastLoginAt instanceof Date);
  });

  test('a used code cannot be replayed', async () => {
    const admin = await makeEnrolledAdmin(base);
    const first = await adminLogin(base, admin);
    assert.equal(first.res.status, 200);
    // Byte-identical code, still inside its window: refused.
    const replay = await req(base, 'POST', '/admin/auth/login', {
      body: { email: admin.email, password: TEST_PASSWORD, totp: code(admin.secret, STEP_MS) },
    });
    assert.equal(replay.status, 401);
  });

  test('an admin who has not enrolled cannot log in at all, only enrol', async () => {
    const admin = await makeAdmin('PLATFORM_SUPPORT');

    const denied = await req(base, 'POST', '/admin/auth/login', {
      body: { email: admin.email, password: TEST_PASSWORD, totp: '123456' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'MFA_ENROLMENT_REQUIRED');

    const enrol = await req(base, 'POST', '/admin/auth/mfa/enrol', {
      body: { email: admin.email, password: TEST_PASSWORD },
    });
    assert.equal(enrol.status, 200);
    assert.match(enrol.body.otpauthUri, /^otpauth:\/\/totp\//);

    // The secret is stored encrypted — a database dump is not a second factor (§9A.2).
    const stored = await raw.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
    assert.ok(stored.mfaSecret);
    assert.match(stored.mfaSecret, /^v1\./);
    assert.ok(!stored.mfaSecret.includes(enrol.body.secret));
    assert.equal(stored.mfaEnabled, false);

    // Wrong code does not enrol.
    const bad = await req(base, 'POST', '/admin/auth/mfa/confirm', {
      body: { email: admin.email, password: TEST_PASSWORD, totp: '000000' },
    });
    assert.equal(bad.status, 401);
    assert.equal(
      (await raw.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).mfaEnabled,
      false,
    );

    const good = await req(base, 'POST', '/admin/auth/mfa/confirm', {
      body: { email: admin.email, password: TEST_PASSWORD, totp: code(enrol.body.secret) },
    });
    assert.equal(good.status, 200);
    const enrolled = await raw.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
    assert.equal(enrolled.mfaEnabled, true);
    assert.ok(enrolled.mfaEnrolledAt instanceof Date);

    // Enrolment issued no session; a real login is still required.
    assert.equal((await req(base, 'GET', '/admin/auth/session')).status, 401);
    const login = await adminLogin(base, { ...admin, secret: enrol.body.secret });
    assert.equal(login.res.status, 200);

    // Re-enrolment is closed once enrolled.
    const again = await req(base, 'POST', '/admin/auth/mfa/enrol', {
      body: { email: admin.email, password: TEST_PASSWORD },
    });
    assert.equal(again.status, 403);
  });

  test("each admin's secret is its own — one does not open another (§9A.2)", async () => {
    const a = await makeEnrolledAdmin(base);
    const b = await makeEnrolledAdmin(base);
    assert.notEqual(a.secret, b.secret);

    const crossed = await req(base, 'POST', '/admin/auth/login', {
      body: { email: b.email, password: TEST_PASSWORD, totp: code(a.secret, STEP_MS) },
    });
    assert.equal(crossed.status, 401);
  });

  test('gives the same message for an unknown admin and a wrong password (§13)', async () => {
    const admin = await makeEnrolledAdmin(base);
    const unknown = await req(base, 'POST', '/admin/auth/login', {
      body: { email: 'nobody@platform.test', password: TEST_PASSWORD, totp: '123456' },
    });
    const wrong = await req(base, 'POST', '/admin/auth/login', {
      body: { email: admin.email, password: 'wrong', totp: '123456' },
    });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.message, 'Invalid email or password');
    assert.equal(wrong.body.message, unknown.body.message);
  });

  test('rate limits repeated admin login attempts', async () => {
    const fresh = await bootApp();
    const prev = process.env.ADMIN_LOGIN_MAX_ATTEMPTS;
    process.env.ADMIN_LOGIN_MAX_ATTEMPTS = '2';
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        codes.push(
          (
            await req(fresh.base, 'POST', '/admin/auth/login', {
              body: { email: 'nobody@platform.test', password: 'wrong', totp: '111111' },
            })
          ).status,
        );
      }
      assert.ok(codes.filter((c) => c === 429).length > 0, `no 429 in ${codes}`);
    } finally {
      process.env.ADMIN_LOGIN_MAX_ATTEMPTS = prev;
      await fresh.app.close();
    }
  });

  test('admin logout clears its own cookie only', async () => {
    const out = await req(base, 'POST', '/admin/auth/logout');
    assert.equal(out.status, 200);
    const setCookie = out.cookies.join(';');
    assert.match(setCookie, new RegExp(`${PLATFORM_COOKIE}=`));
    assert.ok(!setCookie.includes(TENANT_COOKIE));
  });
});
