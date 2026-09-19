// M5 — dormancy & reactivation (§5.6).
//
//   scan → ACTIVE dealers with no order in N days → DORMANT → a nudge (drafted by the AI
//   around database values, §1.4) → auto-sent or queued by average order value
//   scan → a DORMANT dealer who has ordered again → REACTIVATED, credited to the nudge
//          only if it plausibly brought the order in (§15)
//
// The thresholds and the transitions are arithmetic (§1.5). The only model involvement is
// the wording of the nudge, and that goes through the same drafting service and checks as
// every other message.
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DormancySettings, PipelineStage, PrismaClient } from '@prisma/client';
import { ApprovalService } from '../../core/approval';
import { AuditService } from '../../core/audit';
import { DraftingService, name, template } from '../../core/drafting';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { currentConsentState, isEligibleForEmail } from '../outreach-email/consent';
import { renderPlain } from '../outreach-email/cold-draft.service';
import { transitionPipelineStage } from '../outreach-email/pipeline';
import { EmailSendService, isPlausibleEmail } from '../outreach-email/send.service';
import { attributedToNudge, autoSendEligible, averageOrderValue, daysSince, isDormant, nudgedRecently } from './rules';

export const DORMANCY_SOURCE_MODULE = 'dormancy';

const NUDGE = template(
  'Hi {{contactName}},\n\n' +
    'It has been a little while since we last heard from {{businessName}}, and we wanted to check in. ' +
    'If there is anything we can help with, or anything that has changed on your side, just reply here — ' +
    'we would be glad to hear from you.\n\n' +
    'Warm regards,\n{{ourBusinessName}}',
);
const NUDGE_SUBJECT = 'Checking in, {{businessName}}';

export type SettingsInput = {
  enabled?: boolean;
  thresholdDays?: number;
  autoSendBelowAov?: number | null;
  attributionWindowDays?: number;
};

type Nudge = 'auto-sent' | 'queued' | `skipped: ${string}`;

export type ScanResult = {
  dryRun: boolean;
  activated: number;
  wentDormant: { dealerId: string; businessName: string; daysSinceOrder: number; nudge: Nudge | 'not attempted' }[];
  reactivated: { dealerId: string; businessName: string; creditedToNudge: boolean }[];
  noOrderHistory: number;
};

@Injectable()
export class DormancyService {
  private readonly logger = new Logger(DormancyService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly drafting: DraftingService,
    private readonly approval: ApprovalService,
    private readonly audit: AuditService,
    private readonly email: EmailSendService,
  ) {}

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: dormancy has no org context (§1.3).');
    return id;
  }

  // ---- settings ------------------------------------------------------------------

  async settings(): Promise<DormancySettings> {
    const existing = await this.prisma.dormancySettings.findFirst();
    return existing ?? this.prisma.dormancySettings.create({ data: { organizationId: this.orgId() } });
  }

  async updateSettings(input: SettingsInput): Promise<DormancySettings> {
    if (input.thresholdDays !== undefined && (!Number.isInteger(input.thresholdDays) || input.thresholdDays < 1)) {
      throw new BadRequestException('thresholdDays must be a whole number of days, at least 1');
    }
    if (input.attributionWindowDays !== undefined && (!Number.isInteger(input.attributionWindowDays) || input.attributionWindowDays < 1)) {
      throw new BadRequestException('attributionWindowDays must be a whole number of days, at least 1');
    }
    if (input.autoSendBelowAov != null && input.autoSendBelowAov < 0) throw new BadRequestException('autoSendBelowAov cannot be negative');
    const current = await this.settings();
    return this.prisma.dormancySettings.update({
      where: { id: current.id },
      data: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.thresholdDays !== undefined ? { thresholdDays: input.thresholdDays } : {}),
        ...(input.attributionWindowDays !== undefined ? { attributionWindowDays: input.attributionWindowDays } : {}),
        ...(input.autoSendBelowAov !== undefined ? { autoSendBelowAov: input.autoSendBelowAov } : {}),
      },
    });
  }

  // ---- the scan -----------------------------------------------------------------

  /**
   * Idempotent: every transition is conditional on the dealer still being in the stage it
   * expects, and a dealer is never nudged twice inside NUDGE_QUIET_DAYS, so a scan that
   * runs twice (a retry, a manual run after the scheduled one) changes nothing the second
   * time. `dryRun` reports what it WOULD do and writes nothing.
   */
  async scan(opts: { now?: Date; dryRun?: boolean } = {}): Promise<ScanResult> {
    const now = opts.now ?? new Date();
    const dryRun = opts.dryRun === true;
    const settings = await this.settings();
    const orgId = this.orgId();
    const result: ScanResult = { dryRun, activated: 0, wentDormant: [], reactivated: [], noOrderHistory: 0 };

    // 1. ONBOARDED → ACTIVE on the first order. Nothing else moves a dealer there, and
    //    without it nobody would ever be ACTIVE for the dormancy rule to act on.
    const firstOrders = await this.prisma.order.groupBy({
      by: ['dealerId'],
      where: { dealer: { pipelineStage: 'ONBOARDED' } },
      _count: { _all: true },
    });
    for (const g of firstOrders) {
      if (dryRun) {
        result.activated++;
        continue;
      }
      const moved = await transitionPipelineStage(this.prisma, this.audit, {
        organizationId: orgId, dealerId: g.dealerId, from: 'ONBOARDED', to: 'ACTIVE', reason: 'First order placed (§5.6)',
      });
      if (moved) result.activated++;
    }

    // 2. Everyone whose activity we can judge: last order, order count, order value.
    const stages: PipelineStage[] = ['ACTIVE', 'REACTIVATED', 'DORMANT'];
    const [grouped, dealers] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['dealerId'],
        where: { dealer: { pipelineStage: { in: stages } } },
        _max: { orderDate: true },
        _sum: { totalValue: true },
        _count: { _all: true },
      }),
      this.prisma.dealer.findMany({ where: { pipelineStage: { in: stages } }, select: { id: true, businessName: true, pipelineStage: true } }),
    ]);
    const stats = new Map(grouped.map((g) => [g.dealerId, g]));

    for (const dealer of dealers) {
      const g = stats.get(dealer.id);
      const lastOrder = g?._max.orderDate ?? null;
      if (!lastOrder) {
        // ACTIVE with no orders on record: there is nothing to measure silence against.
        // Flagging them dormant would be inventing a fact, so they are only counted.
        result.noOrderHistory++;
        continue;
      }
      const dormant = isDormant(lastOrder, settings.thresholdDays, now);

      if (dealer.pipelineStage === 'DORMANT' && !dormant) {
        // The loop closes (§5.6): they ordered again.
        const nudgeSentAt = await this.lastNudgeAt(dealer.id);
        const credited = attributedToNudge(lastOrder, nudgeSentAt, settings.attributionWindowDays);
        result.reactivated.push({ dealerId: dealer.id, businessName: dealer.businessName, creditedToNudge: credited });
        if (!dryRun) {
          await transitionPipelineStage(this.prisma, this.audit, {
            organizationId: orgId, dealerId: dealer.id, from: 'DORMANT', to: 'REACTIVATED',
            reason: credited
              ? `Ordered again after our nudge (${daysSince(nudgeSentAt!, lastOrder)} days later) (§5.6)`
              : 'Ordered again with no nudge in the attribution window (§5.6)',
          });
        }
      } else if (dealer.pipelineStage !== 'DORMANT' && dormant) {
        const aov = averageOrderValue(Number(g!._sum.totalValue ?? 0), g!._count._all);
        const entry: ScanResult['wentDormant'][number] = {
          dealerId: dealer.id, businessName: dealer.businessName, daysSinceOrder: daysSince(lastOrder, now), nudge: 'not attempted',
        };
        result.wentDormant.push(entry);
        if (dryRun) continue;

        const moved = await transitionPipelineStage(this.prisma, this.audit, {
          organizationId: orgId, dealerId: dealer.id, from: dealer.pipelineStage, to: 'DORMANT',
          reason: `No order in ${entry.daysSinceOrder} days (threshold ${settings.thresholdDays}) (§5.6)`,
        });
        if (moved) entry.nudge = await this.nudge(dealer.id, aov, settings, now);
      }
    }

    if (!dryRun) {
      await this.prisma.dormancySettings.update({
        where: { id: settings.id },
        data: {
          lastScanAt: now,
          lastScanSummary: { activated: result.activated, wentDormant: result.wentDormant.length, reactivated: result.reactivated.length },
        },
      });
    }
    return result;
  }

  // ---- the nudge ---------------------------------------------------------------

  private async lastNudgeAt(dealerId: string): Promise<Date | null> {
    const d = await this.prisma.messageDraft.findFirst({
      where: { dealerId, sourceModule: DORMANCY_SOURCE_MODULE, sentAt: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    });
    return d?.sentAt ?? null;
  }

  /**
   * One check-in email. Skipped — and the reason kept — for a dealer we must not, or
   * cannot, email; never an error that aborts the scan for everyone behind them.
   */
  private async nudge(dealerId: string, aov: number | null, settings: DormancySettings, now: Date): Promise<Nudge> {
    try {
      const dealer = await this.prisma.dealer.findFirst({ where: { id: dealerId }, include: { emails: true } });
      if (!dealer) return 'skipped: dealer not found';
      if (!isEligibleForEmail(await currentConsentState(this.prisma, dealerId, 'EMAIL'))) return 'skipped: opted out of email';
      const address = (dealer.emails.find((e) => e.isPrimary) ?? dealer.emails[0])?.address;
      if (!address || !isPlausibleEmail(address)) return 'skipped: no usable email address';

      const recent = await this.prisma.messageDraft.findFirst({
        where: { dealerId, sourceModule: DORMANCY_SOURCE_MODULE },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (nudgedRecently(recent?.createdAt ?? null, now)) return 'skipped: nudged recently';

      const org = await this.prisma.organization.findFirst({ select: { name: true } });
      const draft = await this.drafting.draft({
        dealerId,
        sourceModule: DORMANCY_SOURCE_MODULE,
        template: NUDGE,
        variables: {
          businessName: name(dealer.businessName),
          contactName: name(dealer.contactPersonName ?? 'Sir/Madam'),
          ourBusinessName: name(org?.name ?? ''),
        },
      });
      const subject = renderPlain(NUDGE_SUBJECT, { businessName: dealer.businessName });
      await this.prisma.messageDraft.update({ where: { id: draft.id }, data: { subject } });

      if (autoSendEligible(aov, settings.autoSendBelowAov ? Number(settings.autoSendBelowAov) : null) && !draft.requiresApproval) {
        const approved = await this.approval.autoSend(draft.id);
        await this.email.sendApprovedDraft(approved.id);
        return 'auto-sent';
      }
      // A higher-value dealer, no threshold set, or no rule for this module: a person
      // looks first. Cleared explicitly so the row is internally consistent rather than
      // relying on the queue to notice.
      await this.prisma.messageDraft.update({ where: { id: draft.id }, data: { requiresApproval: true, autoSendRuleId: null } });
      return 'queued';
    } catch (err) {
      this.logger.warn(`nudge for ${dealerId} failed: ${err instanceof Error ? err.message : err}`);
      return `skipped: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ---- reads ---------------------------------------------------------------------

  /** Baselines the case study needs before this module goes live (§15): how many dormant
   *  dealers, and what they used to be worth. */
  async overview() {
    const settings = await this.settings();
    const dormant = await this.prisma.dealer.findMany({ where: { pipelineStage: 'DORMANT' }, select: { id: true, businessName: true, city: true } });
    const ids = dormant.map((d) => d.id);
    const orders = ids.length
      ? await this.prisma.order.groupBy({ by: ['dealerId'], where: { dealerId: { in: ids } }, _max: { orderDate: true }, _sum: { totalValue: true }, _count: { _all: true } })
      : [];
    const byDealer = new Map(orders.map((o) => [o.dealerId, o]));
    const rows = dormant
      .map((d) => {
        const o = byDealer.get(d.id);
        return {
          dealerId: d.id,
          businessName: d.businessName,
          city: d.city,
          lastOrderDate: o?._max.orderDate ?? null,
          daysSinceOrder: o?._max.orderDate ? daysSince(o._max.orderDate) : null,
          averageOrderValue: o ? averageOrderValue(Number(o._sum.totalValue ?? 0), o._count._all) : null,
        };
      })
      .sort((a, b) => (b.averageOrderValue ?? 0) - (a.averageOrderValue ?? 0));

    const aovs = rows.map((r) => r.averageOrderValue).filter((v): v is number => v !== null);
    const [reactivatedNow, reactivationAudits] = await Promise.all([
      this.prisma.dealer.count({ where: { pipelineStage: 'REACTIVATED' } }),
      this.prisma.auditEvent.findMany({
        where: { organizationId: this.orgId(), action: 'PIPELINE_STAGE_CHANGED', metadata: { path: ['to'], equals: 'REACTIVATED' } },
        select: { metadata: true },
      }),
    ]);
    const credited = reactivationAudits.filter((a) => String((a.metadata as { reason?: string })?.reason ?? '').includes('after our nudge')).length;

    return {
      settings,
      dormantCount: rows.length,
      averageHistoricalOrderValue: aovs.length ? Math.round((aovs.reduce((s, v) => s + v, 0) / aovs.length) * 100) / 100 : null,
      reactivatedNow,
      reactivationsEver: reactivationAudits.length,
      reactivationsCreditedToNudge: credited,
      dormant: rows.slice(0, 200),
    };
  }
}
