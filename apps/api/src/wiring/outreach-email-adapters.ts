import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PRISMA } from '../core/tenancy/tenancy.module';
import { ThrottleService } from '../core/throttle/throttle.service';
import { KillSwitchService } from '../core/killswitch/killswitch.service';
import type { SendThrottle, SendThrottleDecision, KillSwitch } from '../modules/outreach-email/ports';

// Binds outreach-email's small ports (ports.ts) to the real shared services that
// landed alongside it (§3: one throttle, one kill switch — not one per module).
// This is the wiring the module's own comments ask for; it lives here rather than
// in outreach-email/ or core/throttle|killswitch so none of those directories has
// to import across the others.

@Injectable()
export class ThrottleServiceAdapter implements SendThrottle {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly throttle: ThrottleService,
  ) {}

  async tryConsume(organizationId: string): Promise<SendThrottleDecision> {
    // v1: one active identity per org, same assumption send.service.ts already makes.
    const identity = await this.prisma.sendingIdentity.findFirst({
      where: { organizationId, verificationStatus: 'VERIFIED' },
      orderBy: { createdAt: 'asc' },
    });
    if (!identity) return { allowed: false, reason: 'no verified sending identity' };
    const allowed = await this.throttle.tryConsume(identity.id);
    return allowed ? { allowed: true } : { allowed: false, reason: 'daily send limit reached' };
  }
}

@Injectable()
export class KillSwitchAdapter implements KillSwitch {
  constructor(private readonly killSwitch: KillSwitchService) {}

  isPaused(channel: 'EMAIL'): Promise<boolean> {
    return this.killSwitch.isPaused(channel);
  }
}
