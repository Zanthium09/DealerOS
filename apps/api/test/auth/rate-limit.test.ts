// Finding 8 — one account's lockout must not lock the platform out.
//
// Both login rate limiters keyed on req.ip. main.ts sets no `trust proxy`, so behind
// Railway/Render req.ip is the load balancer for every request: one shared bucket for
// everyone. Six anonymous POSTs to /admin/auth/login inside a minute exhausted it
// (ADMIN_LOGIN_MAX_ATTEMPTS=5) and every real operator got 429, repeatable for as long
// as the attacker cared to keep going. The tenant limiter was the same, org-wide.
//
// The existing tests passed because they run against 127.0.0.1, where req.ip really
// is per-client — the one deployment shape in which the bug is invisible.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { bootApp, raw, req } from '../support';
import { TEST_PASSWORD, makeAdmin, makeOrg, makeUser } from './fixtures';
import { TenantLoginRateLimitGuard } from '../../src/core/auth/login-rate-limit.guard';
import { PlatformLoginRateLimitGuard } from '../../src/core/platform-admin/login-rate-limit.guard';

let app: INestApplication;
let base: string;
let victim: { email: string };
let bystander: { email: string };
let adminVictim: { email: string };
let adminBystander: { email: string };

before(async () => {
  // Its own app instance: the limiter is per instance and these tests fill it.
  ({ app, base } = await bootApp());
  const orgId = await makeOrg();
  victim = await makeUser(orgId, 'OWNER');
  bystander = await makeUser(orgId, 'OWNER');
  adminVictim = await makeAdmin();
  adminBystander = await makeAdmin();
});

after(async () => {
  await app.close();
  await raw.$disconnect();
});

/** Hammers one login endpoint with the given body and returns the status codes. */
async function hammer(path: string, body: Record<string, unknown>, times: number) {
  const codes: number[] = [];
  for (let i = 0; i < times; i += 1) {
    codes.push((await req(base, 'POST', path, { body })).status);
  }
  return codes;
}

describe('login rate limiting is per account, not per source IP (finding 8)', () => {
  for (const flow of [
    {
      name: 'tenant',
      path: '/auth/login',
      envVar: 'AUTH_LOGIN_MAX_ATTEMPTS',
      body: (email: string) => ({ email, password: 'wrong' }),
      accounts: () => [victim.email, bystander.email] as const,
    },
    {
      name: 'platform admin',
      path: '/admin/auth/login',
      envVar: 'ADMIN_LOGIN_MAX_ATTEMPTS',
      body: (email: string) => ({ email, password: 'wrong', totp: '111111' }),
      accounts: () => [adminVictim.email, adminBystander.email] as const,
    },
  ]) {
    test(`${flow.name}: locking one account does not lock another`, async () => {
      const prev = process.env[flow.envVar];
      process.env[flow.envVar] = '2';
      try {
        const [locked, other] = flow.accounts();

        const hammered = await hammer(flow.path, flow.body(locked), 5);
        assert.equal(hammered[hammered.length - 1], 429, `no lockout: ${hammered}`);

        // The whole finding: a different account is untouched. Under the old
        // req.ip key this was 429 too — and so was every genuine operator.
        const collateral = (await req(base, 'POST', flow.path, { body: flow.body(other) })).status;
        assert.notEqual(collateral, 429, `${other} was locked out by ${locked}'s bucket`);
        assert.equal(collateral, 401);
      } finally {
        if (prev === undefined) delete process.env[flow.envVar];
        else process.env[flow.envVar] = prev;
      }
    });

    test(`${flow.name}: anonymous floods cannot starve a named account`, async () => {
      const prev = process.env[flow.envVar];
      process.env[flow.envVar] = '2';
      try {
        const [, other] = flow.accounts();
        // No email at all — the shared per-IP fallback bucket, the only one an
        // attacker behind the same proxy as everyone else can reach.
        const flood = await hammer(flow.path, { password: 'wrong', totp: '111111' }, 5);
        assert.ok(flood.includes(429), `the fallback bucket never filled: ${flood}`);

        const named = (await req(base, 'POST', flow.path, { body: flow.body(other) })).status;
        assert.notEqual(named, 429);
      } finally {
        if (prev === undefined) delete process.env[flow.envVar];
        else process.env[flow.envVar] = prev;
      }
    });

    test(`${flow.name}: an unknown address is rate limited exactly like a real one`, async () => {
      // The key is whatever the request carried, never a database lookup, so a 429
      // says nothing about whether the account exists (§13 — no user enumeration).
      const prev = process.env[flow.envVar];
      process.env[flow.envVar] = '2';
      try {
        const unknown = await hammer(
          flow.path,
          flow.body(`nobody-${Date.now().toString(36)}@nowhere.test`),
          5,
        );
        assert.equal(unknown[unknown.length - 1], 429);
        assert.deepEqual(
          unknown.slice(0, 2),
          [401, 401],
          'an unknown address took a different path to the limit than a real one',
        );
      } finally {
        if (prev === undefined) delete process.env[flow.envVar];
        else process.env[flow.envVar] = prev;
      }
    });
  }
});

// The overflow guard used to be `if (this.hits.size > 10_000) this.hits.clear()` —
// which drops LIVE buckets, lockouts included. An attacker capped on one account
// pushed ~10k requests carrying distinct emails, the map was wiped, and the victim's
// counter restarted inside the same 60s window: ~1000:1 amplification, and every
// other operator's counter flushed with it. Overflow may only evict expired entries.
describe('the overflow sweep never drops a live lockout', () => {
  const ctx = (body: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, ip: '10.0.0.1', body }) }),
    }) as unknown as ExecutionContext;

  for (const flow of [
    { name: 'tenant', guard: () => new TenantLoginRateLimitGuard(), envVar: 'AUTH_LOGIN_MAX_ATTEMPTS' },
    { name: 'platform admin', guard: () => new PlatformLoginRateLimitGuard(), envVar: 'ADMIN_LOGIN_MAX_ATTEMPTS' },
  ]) {
    test(`${flow.name}: a flood of fresh keys does not reset a locked account`, () => {
      const prev = process.env[flow.envVar];
      process.env[flow.envVar] = '2';
      try {
        const guard = flow.guard();
        const victim = ctx({ email: 'victim@test.local' });

        guard.canActivate(victim);
        guard.canActivate(victim);
        assert.throws(() => guard.canActivate(victim), /Too many login attempts/);

        // Overflow the map with distinct, still-live keys.
        for (let i = 0; i < 12_000; i += 1) guard.canActivate(ctx({ email: `flood-${i}@test.local` }));

        assert.throws(
          () => guard.canActivate(victim),
          /Too many login attempts/,
          'the lockout was flushed by the overflow sweep',
        );
      } finally {
        if (prev === undefined) delete process.env[flow.envVar];
        else process.env[flow.envVar] = prev;
      }
    });
  }
});
