import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CallLog, CallOutcome, Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../../core/audit';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { currentConsentState, writeConsent } from '../outreach-email/consent';
import { transitionPipelineStage } from '../outreach-email/pipeline';
import { Candidate, interactionStatusFor, rank, reasonFor, recentlyCalled, stepsFor } from './rules';

export type LogCallInput = {
  dealerId: string;
  outcome: CallOutcome;
  notes?: string | null;
  durationSeconds?: number | null;
  followUpAt?: string | null;
  userId: string;
};

const DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class CallService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: calling has no org context (§1.3).');
    return id;
  }

  /**
   * Records what a person did and said, then applies only its deterministic consequences:
   * pipeline steps (audited, never backwards), a do-not-call opt-out, a bad-number flag.
   * The outcome is the human's judgement; nothing here infers it.
   */
  async log(input: LogCallInput): Promise<CallLog> {
    if (!Object.values(CallOutcome).includes(input.outcome)) throw new BadRequestException('unknown call outcome');
    const dealer = await this.prisma.dealer.findFirst({ where: { id: input.dealerId }, include: { phones: true } });
    if (!dealer) throw new NotFoundException(`no dealer ${input.dealerId} in this organization`);

    let followUpAt: Date | null = null;
    if (input.followUpAt) {
      followUpAt = new Date(input.followUpAt);
      if (Number.isNaN(followUpAt.getTime())) throw new BadRequestException('followUpAt is not a valid date');
    }
    const phone = dealer.phones.find((p) => p.isPrimary && p.e164) ?? dealer.phones.find((p) => p.e164) ?? null;
    const orgId = this.orgId();

    const log = await this.prisma.callLog.create({
      data: {
        organizationId: orgId,
        dealerId: dealer.id,
        calledByUserId: input.userId,
        phoneE164: phone?.e164 ?? null,
        outcome: input.outcome,
        notes: input.notes?.trim() || null,
        durationSeconds: input.durationSeconds && input.durationSeconds > 0 ? Math.floor(input.durationSeconds) : null,
        followUpAt,
      },
    });

    // Every touch is one InteractionEvent (§4) — this is what lets the next brief, the
    // dealer's history page and warm-routing see the call.
    await this.prisma.interactionEvent.create({
      data: {
        dealerId: dealer.id,
        channel: 'CALL',
        direction: 'OUTBOUND',
        status: interactionStatusFor(input.outcome),
        toAddress: phone?.e164 ?? '',
        body: `Call: ${input.outcome.replace(/_/g, ' ').toLowerCase()}${input.notes?.trim() ? ` — ${input.notes.trim()}` : ''}`,
      } as Prisma.InteractionEventUncheckedCreateInput,
    });

    // A completed follow-up: this call answers any earlier promise to call back.
    await this.prisma.callLog.updateMany({
      where: { dealerId: dealer.id, followUpDone: false, followUpAt: { not: null }, id: { not: log.id } },
      data: { followUpDone: true },
    });

    for (const step of stepsFor(input.outcome)) {
      await transitionPipelineStage(this.prisma, this.audit, {
        organizationId: orgId,
        dealerId: dealer.id,
        from: step.from,
        to: step.to,
        reason: `Call logged: ${input.outcome} (§5.4)`,
      });
    }

    if (input.outcome === 'DO_NOT_CALL' && (await currentConsentState(this.prisma, dealer.id, 'CALL')) !== 'OPTED_OUT') {
      await writeConsent(this.prisma, { organizationId: orgId, dealerId: dealer.id, channel: 'CALL', state: 'OPTED_OUT', source: 'VERBAL' });
    }
    if (input.outcome === 'WRONG_NUMBER' && phone) {
      // Data hygiene: the number that was just called is not this dealer's.
      await this.prisma.dealerPhone.updateMany({ where: { dealerId: dealer.id, e164: phone.e164 }, data: { valid: false } });
    }
    return log;
  }

  history(dealerId: string): Promise<CallLog[]> {
    return this.prisma.callLog.findMany({ where: { dealerId }, orderBy: { calledAt: 'desc' }, take: 50 });
  }

  /** Follow-ups a person promised, soonest first — including the ones now overdue. */
  followUps() {
    return this.prisma.callLog.findMany({
      where: { followUpAt: { not: null }, followUpDone: false },
      orderBy: { followUpAt: 'asc' },
      take: 100,
      include: { dealer: { select: { id: true, businessName: true, city: true } } },
    });
  }

  async completeFollowUp(id: string): Promise<void> {
    const { count } = await this.prisma.callLog.updateMany({ where: { id }, data: { followUpDone: true } });
    if (count === 0) throw new NotFoundException(`no call ${id}`);
  }

  /**
   * Who to call next. Built from what already happened — promised call-backs, dealers
   * who are interested but not onboarded, anyone who wrote to us recently — minus anyone
   * who said not to call, and minus anyone just called with nothing pending. A person
   * still chooses; this only orders their day.
   */
  async queue(now: Date = new Date()) {
    const since14 = new Date(now.getTime() - 14 * DAY);

    const [followUps, interested, recentInbound, callConsent] = await Promise.all([
      this.prisma.callLog.findMany({ where: { followUpAt: { lte: now }, followUpDone: false }, select: { dealerId: true, followUpAt: true } }),
      this.prisma.dealer.findMany({ where: { pipelineStage: 'INTERESTED' }, select: { id: true } }),
      this.prisma.interactionEvent.findMany({
        where: { direction: 'INBOUND', createdAt: { gte: since14 }, dealer: { pipelineStage: { in: ['NEW', 'CONTACTED', 'INTERESTED'] } } },
        select: { dealerId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.consentLog.findMany({ where: { channel: 'CALL' }, orderBy: { createdAt: 'desc' }, distinct: ['dealerId'] }),
    ]);

    const doNotCall = new Set(callConsent.filter((c) => c.state === 'OPTED_OUT').map((c) => c.dealerId));
    const ids = [...new Set([...followUps.map((f) => f.dealerId), ...interested.map((d) => d.id), ...recentInbound.map((e) => e.dealerId)])].filter(
      (id) => !doNotCall.has(id),
    );
    if (ids.length === 0) return [];

    const [dealers, lastCalls] = await Promise.all([
      this.prisma.dealer.findMany({
        where: { id: { in: ids }, phones: { some: { valid: true, e164: { not: null } } } },
        include: { phones: true },
      }),
      this.prisma.callLog.findMany({ where: { dealerId: { in: ids } }, orderBy: { calledAt: 'desc' }, distinct: ['dealerId'], select: { dealerId: true, calledAt: true } }),
    ]);
    const lastCalled = new Map(lastCalls.map((c) => [c.dealerId, c.calledAt]));
    const followUpDue = new Map<string, Date>();
    for (const f of followUps) {
      const cur = followUpDue.get(f.dealerId);
      if (f.followUpAt && (!cur || f.followUpAt < cur)) followUpDue.set(f.dealerId, f.followUpAt);
    }
    const lastInbound = new Map<string, Date>();
    for (const e of recentInbound) if (!lastInbound.has(e.dealerId)) lastInbound.set(e.dealerId, e.createdAt);

    const items = dealers
      .map((d) => ({
        dealerId: d.id,
        businessName: d.businessName,
        city: d.city,
        contactPersonName: d.contactPersonName,
        phone: (d.phones.find((p) => p.isPrimary && p.valid && p.e164) ?? d.phones.find((p) => p.valid && p.e164))?.e164 ?? null,
        stage: d.pipelineStage,
        followUpDue: followUpDue.get(d.id) ?? null,
        lastInboundAt: lastInbound.get(d.id) ?? null,
        lastCalledAt: lastCalled.get(d.id) ?? null,
      }))
      .filter((c) => !recentlyCalled(c, now));

    return rank(items, now)
      .slice(0, 100)
      .map((c) => ({ ...c, reason: reasonFor(c, now) }));
  }
}
