import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { PRISMA } from '../tenancy/tenancy.module';
import { REDIS } from './throttle.tokens';
import { effectiveDailyLimit } from './warmup';

// §3 — ONE throttle service, not one per module. §13 lists this as a money path:
// two workers racing to send for the same identity must never both believe they have
// the last slot of the day.
//
// Correctness under concurrency comes from Redis INCR, which is atomic on a single
// key even with many callers hitting it at once (Redis processes commands
// one-at-a-time). Each caller gets back the count AFTER its own increment; only the
// caller(s) whose returned count is <= the limit may proceed. A call that loses the
// race still incremented the counter — that is fine, it only ever pushes the count
// further past the limit it already exceeded, never lets a later call sneak under it.
//
// ponytail: the daily bucket is a UTC calendar day, not org-local time. Good enough
// for a hard safety cap; swap for a per-org timezone key if a batch ever needs limits
// to reset exactly at local midnight.
function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const DAY_TTL_SECONDS = 60 * 60 * 48; // covers clock skew across the boundary

@Injectable()
export class ThrottleService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  private key(identityId: string, now?: Date): string {
    return `throttle:identity:${identityId}:${dayKey(now)}`;
  }

  /** How many sends this identity has already used up today. */
  async countToday(identityId: string, now?: Date): Promise<number> {
    const v = await this.redis.get(this.key(identityId, now));
    return v ? Number(v) : 0;
  }

  /**
   * Atomically claims one send for this identity if today's limit isn't used up.
   * Returns true (send allowed) or false (limit reached — do not send).
   */
  async tryConsume(identityId: string, now = new Date()): Promise<boolean> {
    const identity = await this.prisma.sendingIdentity.findUniqueOrThrow({
      where: { id: identityId },
    });
    const limit = effectiveDailyLimit({
      currentDailyLimit: identity.currentDailyLimit,
      warmupStartedAt: identity.warmupStartedAt,
      now,
    });

    const key = this.key(identityId, now);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, DAY_TTL_SECONDS);
    return count <= limit;
  }
}
