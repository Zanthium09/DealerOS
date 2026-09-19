import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertNoDigits } from '../../core/drafting';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { AI_PROVIDER, AIProvider } from '../../providers/ai/ai.provider';
import { currentConsentState } from '../outreach-email/consent';
import { SyncService } from '../sync';
import { formatInr, TALKING_POINTS_SYSTEM } from './rules';

const HISTORY_LIMIT = 15;
const BODY_CHARS = 400;

/**
 * §5.4 — "AI compiles a call brief from that dealer's InteractionEvent rows."
 *
 * The brief is for a salesperson, not the dealer — but §1.4 still holds where it counts:
 * every figure in it (revenue, what they owe, when they last ordered) is rendered from
 * the database by code, and the model is asked only for three plain talking points and is
 * checked for numerals. If it slips one in, the talking points are withheld rather than
 * shown — a salesperson must never quote a number a model made up on a call.
 */
@Injectable()
export class BriefService {
  private readonly logger = new Logger(BriefService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
    private readonly sync: SyncService,
  ) {}

  async brief(dealerId: string) {
    const dealer = await this.prisma.dealer.findFirst({ where: { id: dealerId }, include: { phones: true, emails: true } });
    if (!dealer) throw new NotFoundException(`no dealer ${dealerId} in this organization`);

    const [events, calls, callConsent, score] = await Promise.all([
      this.prisma.interactionEvent.findMany({
        // Delivery bookkeeping rows have an empty body and say nothing about the relationship.
        where: { dealerId, NOT: { body: '' } },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
      }),
      this.prisma.callLog.findMany({ where: { dealerId }, orderBy: { calledAt: 'desc' }, take: 5 }),
      currentConsentState(this.prisma, dealerId, 'CALL'),
      this.sync.scorecard(dealerId),
    ]);

    const phone = (dealer.phones.find((p) => p.isPrimary && p.valid && p.e164) ?? dealer.phones.find((p) => p.valid && p.e164))?.e164 ?? null;
    const lastInbound = events.find((e) => e.direction === 'INBOUND') ?? null;
    const lastOutbound = events.find((e) => e.direction === 'OUTBOUND') ?? null;

    const { talkingPoints, talkingPointsNote } = await this.talkingPoints([...events].reverse());

    return {
      dealer: {
        id: dealer.id,
        businessName: dealer.businessName,
        contactPersonName: dealer.contactPersonName,
        city: dealer.city,
        state: dealer.state,
        category: dealer.businessCategory,
        stage: dealer.pipelineStage,
        source: dealer.source,
        notes: dealer.notes,
      },
      callTo: phone,
      doNotCall: callConsent === 'OPTED_OUT',
      alternatePhones: dealer.phones.filter((p) => p.e164 && p.e164 !== phone).map((p) => p.e164),
      // All rendered here, from database values (§1.4).
      relationship: {
        ordersPlaced: score.orderCount,
        lifetimeRevenue: score.orderCount ? formatInr(score.totalRevenue) : null,
        lastOrder: score.lastOrderDate,
        daysSinceLastOrder: score.daysSinceLastOrder,
        outstanding: score.outstanding > 0 ? formatInr(score.outstanding) : null,
        overdue: score.overdue > 0 ? formatInr(score.overdue) : null,
        averageDaysToPay: score.averageDaysToPay,
      },
      lastInboundAt: lastInbound?.createdAt ?? null,
      lastOutboundAt: lastOutbound?.createdAt ?? null,
      timeline: events.map((e) => ({ at: e.createdAt, channel: e.channel, direction: e.direction, status: e.status, body: e.body.slice(0, 300) })),
      previousCalls: calls.map((c) => ({ at: c.calledAt, outcome: c.outcome, notes: c.notes, followUpAt: c.followUpAt })),
      talkingPoints,
      talkingPointsNote,
    };
  }

  private async talkingPoints(chronological: { createdAt: Date; channel: string; direction: string; body: string }[]) {
    if (chronological.length === 0) {
      return { talkingPoints: null as string[] | null, talkingPointsNote: 'No messages with this dealer yet — nothing to summarise.' };
    }
    const history = chronological
      .map((e) => `[${e.createdAt.toISOString().slice(0, 10)} ${e.channel.toLowerCase()} ${e.direction === 'INBOUND' ? 'dealer said' : 'we said'}] ${e.body.slice(0, BODY_CHARS)}`)
      .join('\n');
    try {
      const out = await this.ai.complete({ system: TALKING_POINTS_SYSTEM, prompt: `History:\n${history}`, maxTokens: 400 });
      const points = out
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
        .filter(Boolean);
      try {
        assertNoDigits(points.join('\n'), 'the talking points');
      } catch {
        return { talkingPoints: null, talkingPointsNote: 'The assistant included a figure, so its summary was withheld — use the timeline below (§1.4).' };
      }
      return { talkingPoints: points.slice(0, 5), talkingPointsNote: null };
    } catch (err) {
      // The brief is still useful without the summary; an AI outage must not block a call.
      this.logger.warn(`talking points unavailable: ${err instanceof Error ? err.message : err}`);
      return { talkingPoints: null, talkingPointsNote: 'The summary is unavailable right now — the timeline below has the history.' };
    }
  }
}
