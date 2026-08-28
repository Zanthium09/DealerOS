import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS } from './killswitch.tokens';
import type { ConsentChannel } from '@prisma/client';

// §12.6 — "the difference between a thirty-second pause and a hotfix is the
// difference between an incident and a damaged relationship." A pause has to:
//   - work without a deploy (so: not an env var, not a code branch)
//   - survive a process restart (so: not in-memory)
//   - be flippable from outside the process (so: not a file only this process can write)
// Redis already runs for BullMQ and is the one piece of shared, persistent, externally
// reachable state this app has — a plain key beats standing up anything new for it.
//
// This gates OUTBOUND broadcast sends only. Inbound webhook processing (core/webhooks)
// never consults this — §7 draws that line explicitly for WhatsApp quality-rating
// pauses, and the same reasoning applies to every channel: a paused channel should
// still let dealers' replies land, only our own sends stop.
const KEY_PREFIX = 'killswitch:channel:';
const PAUSED = 'paused';

@Injectable()
export class KillSwitchService {
  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  private key(channel: ConsentChannel | string): string {
    return `${KEY_PREFIX}${channel}`;
  }

  async isPaused(channel: ConsentChannel | string): Promise<boolean> {
    return (await this.redis.get(this.key(channel))) === PAUSED;
  }

  async pause(channel: ConsentChannel | string): Promise<void> {
    await this.redis.set(this.key(channel), PAUSED);
  }

  async resume(channel: ConsentChannel | string): Promise<void> {
    await this.redis.del(this.key(channel));
  }

  /** Throws if the channel is paused. Call this first, before any send attempt. */
  async assertNotPaused(channel: ConsentChannel | string): Promise<void> {
    if (await this.isPaused(channel)) {
      throw new ChannelPausedError(channel);
    }
  }
}

export class ChannelPausedError extends Error {
  constructor(public readonly channel: string) {
    super(`sends on channel ${channel} are paused (§12.6 kill switch)`);
    this.name = 'ChannelPausedError';
  }
}
