// §6 / §13 — send throttling and the warmup ramp. Real Postgres for SendingIdentity,
// real Redis for the counter (the thing whose correctness under concurrency actually
// matters here).
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { ThrottleService } from '../../src/core/throttle/throttle.service';
import { effectiveDailyLimit, warmupRampLimit } from '../../src/core/throttle/warmup';
import { newRedisConnection } from '../../src/core/redis';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());
const redis = newRedisConnection();

const ORG = 'throttle-org';
const IDENTITY_LOW = 'throttle-identity-low'; // small limit, exercises the concurrency race
const IDENTITY_WARMUP = 'throttle-identity-warmup';

before(async () => {
  // Unlike Postgres (a fresh throwaway DB per `pnpm test` run, test/run.mjs), Redis is
  // the real, persistent instance — a counter key from an earlier run today would
  // still be sitting there otherwise and make this test flaky/fail on rerun.
  const staleKeys = await redis.keys(`throttle:identity:${IDENTITY_LOW}:*`);
  staleKeys.push(...(await redis.keys(`throttle:identity:${IDENTITY_WARMUP}:*`)));
  if (staleKeys.length) await redis.del(...staleKeys);

  await raw.organization.create({ data: { id: ORG, name: 'Throttle Co', slug: ORG } });
  await raw.sendingIdentity.create({
    data: { id: IDENTITY_LOW, organizationId: ORG, domain: 'mail-low.test', provider: 'resend', currentDailyLimit: 5 },
  });
  await raw.sendingIdentity.create({
    data: {
      id: IDENTITY_WARMUP,
      organizationId: ORG,
      domain: 'mail-warmup.test',
      provider: 'resend',
      currentDailyLimit: 1000, // org set it high; warmup should still cap it
      warmupStartedAt: new Date(), // day 0
    },
  });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
  redis.disconnect();
});

describe('§6 — warmup ramp', () => {
  test('starts near 20/day and rises to the 50/day hard cap by day 14', () => {
    assert.equal(warmupRampLimit(0), 20);
    assert.ok(warmupRampLimit(7) > 20 && warmupRampLimit(7) < 50, `day 7 = ${warmupRampLimit(7)}`);
    assert.equal(warmupRampLimit(14), 50);
    assert.equal(warmupRampLimit(30), 50); // hard cap, never exceeded
  });

  test('effectiveDailyLimit caps a larger org-set limit during warmup', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    const warmupStartedAt = new Date('2026-01-15T00:00:00Z'); // day 0
    const limit = effectiveDailyLimit({ currentDailyLimit: 1000, warmupStartedAt, now });
    assert.equal(limit, 20);
  });

  test('effectiveDailyLimit defers to currentDailyLimit once warmup and its grace window have passed', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    const warmupStartedAt = new Date('2026-01-01T00:00:00Z'); // ~60 days ago
    const limit = effectiveDailyLimit({ currentDailyLimit: 35, warmupStartedAt, now });
    assert.equal(limit, 35);
  });

  test('with no warmup on record, currentDailyLimit governs directly', () => {
    const limit = effectiveDailyLimit({ currentDailyLimit: 40, warmupStartedAt: null });
    assert.equal(limit, 40);
  });
});

describe('§6 / §13 — the daily limit is not exceeded under concurrent sends', () => {
  test('exactly `limit` of N concurrent tryConsume calls succeed, never more', async () => {
    const service = new ThrottleService(scoped as unknown as PrismaClient, redis);
    const CONCURRENCY = 20; // well above the identity's limit of 5

    const results = await runWithOrg(ORG, () =>
      Promise.all(Array.from({ length: CONCURRENCY }, () => service.tryConsume(IDENTITY_LOW))),
    );

    const allowed = results.filter(Boolean).length;
    assert.equal(allowed, 5, `expected exactly the 5/day limit to be claimed, got ${allowed}`);

    const count = await runWithOrg(ORG, () => service.countToday(IDENTITY_LOW));
    assert.equal(count, CONCURRENCY); // every attempt incremented; only 5 were allowed to send
  });

  test('a fresh identity mid-warmup is throttled to the ramp value, not the org-set limit', async () => {
    const service = new ThrottleService(scoped as unknown as PrismaClient, redis);
    const now = new Date(); // day 0 of warmup → limit 20, even though currentDailyLimit is 1000

    const results = await runWithOrg(ORG, () =>
      Promise.all(Array.from({ length: 25 }, () => service.tryConsume(IDENTITY_WARMUP, now))),
    );
    assert.equal(results.filter(Boolean).length, 20);
  });
});
