import { Inject, Injectable } from '@nestjs/common';
import { OutreachSettings, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';

export type OutreachSettingsInput = {
  throttleEnabled?: boolean;
  warmupEnabled?: boolean;
  dailyLimit?: number;
  minSendIntervalMs?: number;
  emailPaused?: boolean;
};

/**
 * The org's outbound controls (§6, §12.6). Defaults are created lazily rather than
 * seeded, so an org that predates this table behaves exactly as it did before —
 * throttle on, warmup on, 50/day.
 *
 * `throttleEnabled = false` removes the application's own daily ceiling entirely.
 * It does NOT remove `minSendIntervalMs`: that one is the provider's rate limit
 * rather than ours, and exceeding it means Resend returns 429 and the mail simply
 * does not go out. Pacing is how you send more, not less.
 */
@Injectable()
export class OutreachSettingsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(organizationId?: string): Promise<OutreachSettings> {
    const orgId = organizationId ?? getOrgId()!;
    const existing = await this.prisma.outreachSettings.findFirst({ where: { organizationId: orgId } });
    if (existing) return existing;
    return this.prisma.outreachSettings.create({ data: { organizationId: orgId } });
  }

  /** The identity whose warmup clock governs today's ramp, if warmup applies. */
  warmupIdentity(organizationId: string): Promise<{ warmupStartedAt: Date | null } | null> {
    return this.prisma.sendingIdentity.findFirst({
      where: { organizationId, verificationStatus: 'VERIFIED' },
      orderBy: { createdAt: 'asc' },
      select: { warmupStartedAt: true },
    });
  }

  async update(input: OutreachSettingsInput): Promise<OutreachSettings> {
    const current = await this.get();
    return this.prisma.outreachSettings.update({
      where: { id: current.id },
      data: {
        ...(input.throttleEnabled !== undefined ? { throttleEnabled: input.throttleEnabled } : {}),
        ...(input.warmupEnabled !== undefined ? { warmupEnabled: input.warmupEnabled } : {}),
        ...(input.emailPaused !== undefined ? { emailPaused: input.emailPaused } : {}),
        // 0 is meaningful (= unlimited); clamp only the nonsense values.
        ...(input.dailyLimit !== undefined ? { dailyLimit: Math.max(0, Math.floor(input.dailyLimit)) } : {}),
        ...(input.minSendIntervalMs !== undefined
          ? { minSendIntervalMs: Math.min(60_000, Math.max(0, Math.floor(input.minSendIntervalMs))) }
          : {}),
      },
    });
  }
}
