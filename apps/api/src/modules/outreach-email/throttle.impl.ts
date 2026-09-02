import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { sharedRedis } from '../../core/redis';
import { effectiveDailyLimit } from '../../core/throttle';
import { KillSwitchService } from '../../core/killswitch';
import { OutreachSettingsService } from './settings.service';
import { KillSwitch, SendThrottle, SendThrottleDecision } from './ports';

/**
 * The real implementations of this module's two ports. Until now
 * `AlwaysAllowThrottle` and `NeverPausedKillSwitch` — placeholders written before
 * core/throttle and core/killswitch existed — were still the ones wired into the
 * module, so neither the throttle nor the kill switch did anything at all in
 * production. The only cap actually in force was the daily-count check inside
 * EmailSendService.
 *
 * Behaviour is now org-configurable (OutreachSettings):
 *   throttleEnabled = false  → no application-level daily ceiling whatsoever
 *   dailyLimit = 0           → likewise unlimited, while keeping the toggle on
 *   warmupEnabled = false    → skip §6's 20/day ramp and its 50/day hard cap
 *
 * `minSendIntervalMs` is enforced regardless of the above, because it is the
 * provider's own rate limit rather than a policy of ours: Resend allows ~2
 * requests/second and answers 429 beyond it, so pacing is what makes a large batch
 * actually arrive instead of half-failing.
 */
const NO_LIMIT = Number.POSITIVE_INFINITY;
const DAY_TTL_SECONDS = 60 * 60 * 48;

@Injectable()
export class EmailSendThrottle implements SendThrottle {
  private readonly redis: IORedis = sharedRedis();

  constructor(private readonly settings: OutreachSettingsService) {}

  async tryConsume(organizationId: string): Promise<SendThrottleDecision> {
    const settings = await this.settings.get(organizationId);

    await this.pace(organizationId, settings.minSendIntervalMs);

    const limit = await this.limitFor(organizationId, settings);
    if (limit === NO_LIMIT) return { allowed: true };

    // Atomic: two workers racing for the last slot of the day cannot both win.
    // The loser's increment only pushes the count further past a limit already
    // exceeded, which is harmless (§13 — this is a money path).
    const key = `outreach:email:sent:${organizationId}:${dayKey()}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, DAY_TTL_SECONDS);
    if (count > limit) {
      return { allowed: false, reason: `daily limit of ${limit} reached for today` };
    }
    return { allowed: true };
  }

  /** What today's ceiling actually is, after settings and the warmup ramp. */
  async limitFor(
    organizationId: string,
    settings?: { throttleEnabled: boolean; warmupEnabled: boolean; dailyLimit: number },
  ): Promise<number> {
    const s = settings ?? (await this.settings.get(organizationId));
    if (!s.throttleEnabled) return NO_LIMIT;

    const configured = s.dailyLimit === 0 ? NO_LIMIT : s.dailyLimit;
    if (!s.warmupEnabled) return configured;

    const identity = await this.identity(organizationId);
    if (!identity?.warmupStartedAt) return configured;
    return effectiveDailyLimit({
      currentDailyLimit: configured === NO_LIMIT ? Number.MAX_SAFE_INTEGER : configured,
      warmupStartedAt: identity.warmupStartedAt,
    });
  }

  async usedToday(organizationId: string): Promise<number> {
    const v = await this.redis.get(`outreach:email:sent:${organizationId}:${dayKey()}`);
    return v ? Number(v) : 0;
  }

  private async identity(organizationId: string): Promise<{ warmupStartedAt: Date | null } | null> {
    // Imported lazily to keep this class free of a Prisma dependency it only needs
    // for one nullable date; the settings service already holds the client.
    return this.settings.warmupIdentity(organizationId);
  }

  /**
   * Sleeps just long enough that consecutive sends for this org stay under the
   * provider's rate limit.
   *
   * ponytail: read-then-write rather than a Lua script, so two concurrent senders
   * can both pass one interval. That costs at most one extra request per tick and
   * Resend tolerates a brief burst; make it a Lua CAS if a second API replica ever
   * starts drawing 429s.
   */
  private async pace(organizationId: string, intervalMs: number): Promise<void> {
    if (intervalMs <= 0) return;
    const key = `outreach:email:lastsend:${organizationId}`;
    const last = Number((await this.redis.get(key)) ?? 0);
    const waitMs = last + intervalMs - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, intervalMs)));
    await this.redis.set(key, String(Date.now()), 'PX', Math.max(intervalMs * 4, 5_000));
  }
}

/** §12.6 — backed by the real Redis kill switch AND the org's own `emailPaused`
 *  toggle, so the dashboard can stop sends without a deploy or a CLI. */
@Injectable()
export class EmailKillSwitch implements KillSwitch {
  constructor(
    private readonly killSwitch: KillSwitchService,
    private readonly settings: OutreachSettingsService,
  ) {}

  async isPaused(channel: 'EMAIL'): Promise<boolean> {
    if (await this.killSwitch.isPaused(channel)) return true;
    return (await this.settings.get()).emailPaused;
  }
}

function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
