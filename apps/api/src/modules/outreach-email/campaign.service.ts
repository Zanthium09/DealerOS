import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Campaign, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { OutreachEmailService } from './outreach-email.service';
import { eligibleForColdOutreach, OutreachSegmentFilter } from './eligibility';
import { SOURCE_MODULE } from './send.service';

export type CampaignInput = {
  name: string;
  segmentFilter?: OutreachSegmentFilter;
  templateId?: string | null;
  scheduledAt?: string | null;
};

/**
 * A named, reusable audience + template pairing (§4's Campaign table, which existed
 * on the schema with no code behind it). Running one is exactly the cold-outreach
 * run the dashboard already does — same drafting, same approval queue, same throttle
 * and consent guards — so this deliberately delegates rather than growing a second
 * send path. What it adds is a saved definition, a preview of who would receive it,
 * and per-campaign reporting.
 */
@Injectable()
export class CampaignService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly outreach: OutreachEmailService,
  ) {}

  list(): Promise<Campaign[]> {
    return this.prisma.campaign.findMany({ where: { channel: 'EMAIL' }, orderBy: { createdAt: 'desc' } });
  }

  async create(input: CampaignInput): Promise<Campaign> {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    return this.prisma.campaign.create({
      data: {
        organizationId: getOrgId()!,
        channel: 'EMAIL',
        name: input.name.trim(),
        segmentFilter: (input.segmentFilter ?? {}) as never,
        templateId: input.templateId ?? null,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      },
    });
  }

  async update(id: string, input: Partial<CampaignInput> & { status?: string }): Promise<Campaign> {
    await this.load(id);
    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.segmentFilter !== undefined ? { segmentFilter: input.segmentFilter as never } : {}),
        ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        ...(input.status !== undefined ? { status: input.status as never } : {}),
        ...(input.scheduledAt !== undefined
          ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null }
          : {}),
      },
    });
  }

  async remove(id: string): Promise<void> {
    await this.load(id);
    await this.prisma.campaign.delete({ where: { id } });
  }

  /**
   * Who would this campaign reach, before anything is drafted or sent. Uses the same
   * eligibility query the run itself uses, so the number shown is the number that
   * actually gets contacted — not an estimate computed a second way.
   */
  async preview(id: string): Promise<{ total: number; sample: { id: string; businessName: string; city: string | null }[] }> {
    const campaign = await this.load(id);
    const dealers = await eligibleForColdOutreach(
      this.prisma,
      (campaign.segmentFilter ?? {}) as OutreachSegmentFilter,
    );
    return {
      total: dealers.length,
      sample: dealers.slice(0, 25).map((d) => ({ id: d.id, businessName: d.businessName, city: d.city })),
    };
  }

  /** Drafts for the campaign's audience. Delegates to the one cold-outreach path. */
  async run(id: string, options: { maxDealers?: number; forceReview?: boolean; allowResend?: boolean } = {}) {
    const campaign = await this.load(id);
    const result = await this.outreach.runColdOutreach(campaign.organizationId, {
      segmentFilter: (campaign.segmentFilter ?? {}) as OutreachSegmentFilter,
      templateId: campaign.templateId ?? undefined,
      maxDealers: options.maxDealers,
      forceReview: options.forceReview,
      allowResend: options.allowResend,
    });
    await this.prisma.campaign.update({ where: { id }, data: { status: 'RUNNING' } });
    return result;
  }

  /**
   * Delivery outcomes for the campaign's audience.
   *
   * ponytail: attributed by dealer membership in the segment, not by a campaignId on
   * InteractionEvent — the column exists but the send path has never written it, and
   * back-filling one from a segment definition would be a guess. Correct for a
   * campaign whose audience does not overlap another's; add real stamping at send
   * time before relying on it for overlapping campaigns.
   */
  async stats(id: string) {
    const campaign = await this.load(id);
    const dealers = await eligibleForColdOutreach(
      this.prisma,
      (campaign.segmentFilter ?? {}) as OutreachSegmentFilter,
    );
    const dealerIds = dealers.map((d) => d.id);
    if (dealerIds.length === 0) return { audience: 0, drafted: 0, byStatus: {} as Record<string, number> };

    const [drafted, events] = await Promise.all([
      this.prisma.messageDraft.count({ where: { sourceModule: SOURCE_MODULE, dealerId: { in: dealerIds } } }),
      this.prisma.interactionEvent.findMany({
        where: { channel: 'EMAIL', direction: 'OUTBOUND', dealerId: { in: dealerIds } },
        select: { status: true, providerMessageId: true, id: true },
      }),
    ]);

    // One count per message, not per delivery event (a delivered-then-opened email
    // is one email).
    const best = new Map<string, string>();
    for (const e of events) {
      const key = e.providerMessageId ?? `local:${e.id}`;
      const seen = best.get(key);
      if (!seen || STATUS_RANK[e.status] > STATUS_RANK[seen]) best.set(key, e.status);
    }
    const byStatus: Record<string, number> = {};
    for (const status of best.values()) byStatus[status] = (byStatus[status] ?? 0) + 1;

    return { audience: dealerIds.length, drafted, byStatus };
  }

  private async load(id: string): Promise<Campaign> {
    const row = await this.prisma.campaign.findFirst({ where: { id } });
    if (!row) throw new BadRequestException(`no campaign ${id} in this organization`);
    return row;
  }
}

const STATUS_RANK: Record<string, number> = {
  SENT: 1,
  DELIVERED: 2,
  OPENED: 3,
  CLICKED: 4,
  REPLIED: 5,
  COMPLAINED: 6,
  BOUNCED: 7,
  FAILED: 8,
};
