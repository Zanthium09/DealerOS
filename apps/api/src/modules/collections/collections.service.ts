// M7 — collections (§5.8).
//
//   ledger → days overdue (oldest unpaid invoice) → rung on the ladder (deterministic)
//     gentle / firm  → a written reminder: AI wording around ledger values (§1.4), always to
//                      the approval queue — it states money owed, so it needs a person (§9)
//     human          → flag for a person's call; never automated (§5.8)
//
// §10.4: stale data never becomes a payment demand. The run refuses if the payments sync
// is older than the freshness window; only invoices seen by a recent sync are chased; and
// approval RE-CHECKS both, because a reminder can sit in the queue for days after it was
// drafted, during which the balance may have been paid.
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CollectionsSettings, EscalationLevel, PrismaClient } from '@prisma/client';
import { ApprovalService } from '../../core/approval';
import { DraftingService, date, money, name, quantity, template } from '../../core/drafting';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { currentConsentState, isEligibleForEmail } from '../outreach-email/consent';
import { renderPlain } from '../outreach-email/cold-draft.service';
import { EmailSendService, isPlausibleEmail } from '../outreach-email/send.service';
import { SyncService } from '../sync';
import { callDue, daysOverdue, isFresh, levelFor, shouldRemind, toPaise, validateThresholds } from './rules';

export const COLLECTIONS_SOURCE_MODULE = 'collections';

// Skeletons the model may only reword. {{amountDue}}, {{invoiceCount}} and
// {{oldestDueDate}} are typed variables rendered in code after the model has returned.
const TEMPLATES: Record<'GENTLE' | 'FIRM', { body: ReturnType<typeof template>; subject: string }> = {
  GENTLE: {
    subject: 'Payment reminder, {{businessName}}',
    body: template(
      'Hi {{contactName}},\n\n' +
        'A friendly reminder from {{ourBusinessName}}. Our records show an outstanding balance of {{amountDue}} for ' +
        '{{businessName}}, across {{invoiceCount}} invoices, the oldest of which fell due on {{oldestDueDate}}.\n\n' +
        'If you have already made this payment, please ignore this note and accept our thanks. Otherwise we would ' +
        'appreciate it if you could settle it at your earliest convenience.\n\n' +
        'Warm regards,\n{{ourBusinessName}}',
    ),
  },
  FIRM: {
    subject: 'Overdue balance, {{businessName}}',
    body: template(
      'Hi {{contactName}},\n\n' +
        'We are following up on an overdue balance of {{amountDue}} for {{businessName}}, across {{invoiceCount}} ' +
        'invoices, the oldest of which fell due on {{oldestDueDate}}. We have not yet received payment.\n\n' +
        'Please arrange payment this week, or reply to let us know if there is anything holding it up so that we can ' +
        'help resolve it.\n\n' +
        'Regards,\n{{ourBusinessName}}',
    ),
  },
};

export type SettingsInput = Partial<Pick<CollectionsSettings, 'enabled' | 'gentleAfterDays' | 'firmAfterDays' | 'humanAfterDays' | 'reminderIntervalDays' | 'freshnessWindowHours'>>;

export type RunResult = {
  dryRun: boolean;
  /** Set when the run declined to proceed — stale data is a refusal, not an error (§10.4). */
  refused: string | null;
  dealersWithOverdue: number;
  remindersDrafted: { dealerId: string; businessName: string; level: 'GENTLE' | 'FIRM'; amountDue: number }[];
  flaggedForCall: { dealerId: string; businessName: string; reason: string }[];
  skipped: { dealerId: string; businessName: string; reason: string }[];
  cleared: number;
};

type DealerDue = { amountDue: number; invoiceCount: number; oldestDaysOverdue: number; oldestDueDate: Date };

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly drafting: DraftingService,
    private readonly approval: ApprovalService,
    private readonly email: EmailSendService,
    private readonly sync: SyncService,
  ) {}

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: collections has no org context (§1.3).');
    return id;
  }

  // ---- settings ------------------------------------------------------------------

  async settings(): Promise<CollectionsSettings> {
    return (await this.prisma.collectionsSettings.findFirst()) ?? this.prisma.collectionsSettings.create({ data: { organizationId: this.orgId() } });
  }

  async updateSettings(input: SettingsInput): Promise<CollectionsSettings> {
    const cur = await this.settings();
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as CollectionsSettings;
    const problem = validateThresholds(next);
    if (problem) throw new BadRequestException(problem);
    for (const k of ['reminderIntervalDays', 'freshnessWindowHours'] as const) {
      if (!Number.isInteger(next[k]) || next[k] < 1) throw new BadRequestException(`${k} must be a whole number, at least 1`);
    }
    return this.prisma.collectionsSettings.update({
      where: { id: cur.id },
      data: {
        enabled: next.enabled,
        gentleAfterDays: next.gentleAfterDays,
        firmAfterDays: next.firmAfterDays,
        humanAfterDays: next.humanAfterDays,
        reminderIntervalDays: next.reminderIntervalDays,
        freshnessWindowHours: next.freshnessWindowHours,
      },
    });
  }

  // ---- what a dealer owes, from the ledger ----------------------------------------

  /**
   * The overdue, unpaid, RECENTLY-SEEN invoices per dealer. `minDays` is the gentle rung:
   * an invoice a day past due is not yet worth a message.
   */
  private async dueByDealer(settings: CollectionsSettings, now: Date): Promise<Map<string, DealerDue>> {
    const entries = await this.prisma.paymentLedgerEntry.findMany({
      select: { dealerId: true, amount: true, paidAmount: true, dueDate: true, lastSyncedAt: true },
    });
    const out = new Map<string, DealerDue>();
    for (const e of entries) {
      const owed = Number(e.amount) - Number(e.paidAmount);
      const days = daysOverdue(e.dueDate, now);
      if (owed <= 0 || days < settings.gentleAfterDays) continue;
      if (!isFresh(e.lastSyncedAt, settings.freshnessWindowHours, now)) continue; // §10.4
      const cur = out.get(e.dealerId);
      if (!cur) {
        out.set(e.dealerId, { amountDue: owed, invoiceCount: 1, oldestDaysOverdue: days, oldestDueDate: e.dueDate });
      } else {
        cur.amountDue += owed;
        cur.invoiceCount += 1;
        if (days > cur.oldestDaysOverdue) {
          cur.oldestDaysOverdue = days;
          cur.oldestDueDate = e.dueDate;
        }
      }
    }
    return out;
  }

  /** null = fresh enough to act on; otherwise why the run must not proceed. */
  private async staleReason(settings: CollectionsSettings, now: Date): Promise<string | null> {
    const last = (await this.sync.freshness()).payments;
    if (!last) return 'No payment data has been imported yet — import your dues under Data Sync before collections can run.';
    if (!isFresh(new Date(last), settings.freshnessWindowHours, now)) {
      return `The payment data was last synced ${new Date(last).toLocaleString()}, older than the ${settings.freshnessWindowHours}-hour freshness window. Import the latest dues first — a reminder built on stale data can demand money that has already been paid.`;
    }
    return null;
  }

  // ---- the run ---------------------------------------------------------------------

  async run(opts: { now?: Date; dryRun?: boolean } = {}): Promise<RunResult> {
    const now = opts.now ?? new Date();
    const dryRun = opts.dryRun === true;
    const settings = await this.settings();
    const result: RunResult = { dryRun, refused: null, dealersWithOverdue: 0, remindersDrafted: [], flaggedForCall: [], skipped: [], cleared: 0 };

    result.refused = await this.staleReason(settings, now);
    if (result.refused) return result;

    // Buckets are a function of time; recalculate before anyone reads them (§5.8).
    if (!dryRun) await this.sync.recalculateAgeing(now);

    const due = await this.dueByDealer(settings, now);
    result.dealersWithOverdue = due.size;
    const dealers = await this.prisma.dealer.findMany({
      where: { id: { in: [...due.keys()] } },
      include: { emails: true },
    });
    const dealerById = new Map(dealers.map((d) => [d.id, d]));

    for (const [dealerId, d] of due) {
      const dealer = dealerById.get(dealerId);
      if (!dealer) continue;
      const level = levelFor(d.oldestDaysOverdue, settings);
      const existing = await this.prisma.collectionCase.findFirst({ where: { dealerId } });
      const base = { level, oldestDaysOverdue: d.oldestDaysOverdue, outstanding: d.amountDue, overdueInvoices: d.invoiceCount };

      // -- the final rung: a person calls. Never a message. ---------------------------
      if (level === 'HUMAN') {
        const due_ = callDue({ level, handledAt: existing?.handledAt ?? null, intervalDays: settings.reminderIntervalDays, now });
        const reason = `${d.oldestDaysOverdue} days overdue, ${d.amountDue.toLocaleString('en-IN', { maximumFractionDigits: 2 })} outstanding — needs a call`;
        if (due_) result.flaggedForCall.push({ dealerId, businessName: dealer.businessName, reason });
        if (!dryRun) await this.saveCase(existing?.id, dealerId, { ...base, needsCall: due_ ? true : (existing?.needsCall ?? false), callReason: due_ ? reason : (existing?.callReason ?? null) });
        continue;
      }

      if (level === 'NONE') continue; // unreachable: dueByDealer drops anything under the gentle rung

      // -- gentle / firm: a reminder, if one is due ---------------------------------
      if (!shouldRemind({ level, lastReminderAt: existing?.lastReminderAt ?? null, lastReminderLevel: existing?.lastReminderLevel ?? null, intervalDays: settings.reminderIntervalDays, now })) {
        if (!dryRun) await this.saveCase(existing?.id, dealerId, base);
        continue;
      }
      const cannot = await this.cannotEmail(dealer);
      if (cannot) {
        // A dealer we owe a reminder but cannot email is exactly one a person should ring.
        result.skipped.push({ dealerId, businessName: dealer.businessName, reason: cannot });
        const reason = `${cannot} — reach them by phone`;
        result.flaggedForCall.push({ dealerId, businessName: dealer.businessName, reason });
        if (!dryRun) await this.saveCase(existing?.id, dealerId, { ...base, needsCall: true, callReason: reason });
        continue;
      }
      if (await this.prisma.messageDraft.findFirst({ where: { dealerId, sourceModule: COLLECTIONS_SOURCE_MODULE, status: 'PENDING' } })) {
        result.skipped.push({ dealerId, businessName: dealer.businessName, reason: 'a reminder is already waiting for approval' });
        continue;
      }
      result.remindersDrafted.push({ dealerId, businessName: dealer.businessName, level, amountDue: d.amountDue });
      if (dryRun) continue;

      await this.draftReminder(dealer, level, d);
      await this.saveCase(existing?.id, dealerId, { ...base, lastReminderAt: now, lastReminderLevel: level });
    }

    if (!dryRun) {
      // Anyone previously chased who owes nothing chaseable now is off the ladder.
      const stillDue = [...due.keys()];
      const cleared = await this.prisma.collectionCase.updateMany({
        where: { level: { not: 'NONE' }, dealerId: { notIn: stillDue } },
        data: { level: 'NONE', needsCall: false, callReason: null, outstanding: 0, overdueInvoices: 0, oldestDaysOverdue: 0 },
      });
      result.cleared = cleared.count;
      const s = await this.settings();
      await this.prisma.collectionsSettings.update({
        where: { id: s.id },
        data: { lastRunAt: now, lastRunSummary: { drafted: result.remindersDrafted.length, calls: result.flaggedForCall.length, cleared: result.cleared } },
      });
    }
    return result;
  }

  private async cannotEmail(dealer: { id: string; emails: { address: string; isPrimary: boolean }[] }): Promise<string | null> {
    if (!isEligibleForEmail(await currentConsentState(this.prisma, dealer.id, 'EMAIL'))) return 'opted out of email';
    const address = (dealer.emails.find((e) => e.isPrimary) ?? dealer.emails[0])?.address;
    if (!address || !isPlausibleEmail(address)) return 'no usable email address';
    return null;
  }

  private async saveCase(id: string | undefined, dealerId: string, data: Record<string, unknown>) {
    if (id) return this.prisma.collectionCase.update({ where: { id }, data: data as never });
    return this.prisma.collectionCase.create({ data: { organizationId: this.orgId(), dealerId, ...data } as never });
  }

  private async draftReminder(
    dealer: { id: string; businessName: string; contactPersonName: string | null },
    level: 'GENTLE' | 'FIRM',
    d: DealerDue,
  ) {
    const org = await this.prisma.organization.findFirst({ select: { name: true } });
    const t = TEMPLATES[level];
    const draft = await this.drafting.draft({
      dealerId: dealer.id,
      sourceModule: COLLECTIONS_SOURCE_MODULE,
      template: t.body,
      variables: {
        contactName: name(dealer.contactPersonName ?? 'Sir/Madam'),
        businessName: name(dealer.businessName),
        ourBusinessName: name(org?.name ?? ''),
        // From the ledger, in whole paise, rendered in code after the model returns (§1.4).
        amountDue: money(toPaise(d.amountDue)),
        invoiceCount: quantity(d.invoiceCount, null),
        oldestDueDate: date(d.oldestDueDate),
      },
    });
    // DraftingService already sets requiresApproval: it carries money, so it is never
    // eligible for auto-send. Belt and braces, in case a rule is ever added by mistake.
    await this.prisma.messageDraft.update({
      where: { id: draft.id },
      data: { subject: renderPlain(t.subject, { businessName: dealer.businessName }), requiresApproval: true, autoSendRuleId: null },
    });
  }

  // ---- approval: re-check before anything goes out (§10.4) ---------------------------

  /**
   * A reminder can sit in the queue for days. Before it goes out the data is checked
   * AGAIN: the payments sync must still be fresh, and the balance the draft states must
   * still be what the ledger says. If not, the draft is rejected (so the next run redrafts
   * it from current numbers) and the person is told why — never sent stale.
   */
  async approveAndSend(draftId: string, userId: string) {
    const draft = await this.prisma.messageDraft.findFirst({ where: { id: draftId, sourceModule: COLLECTIONS_SOURCE_MODULE } });
    if (!draft) throw new BadRequestException(`no collections draft ${draftId}`);
    const settings = await this.settings();
    const now = new Date();

    const stale = await this.staleReason(settings, now);
    if (stale) throw new BadRequestException(`${stale} Not sent.`);

    const due = (await this.dueByDealer(settings, now)).get(draft.dealerId);
    const stated = (draft.templateVariables as { amountDue?: { amountPaise?: number } })?.amountDue?.amountPaise;
    if (!due || stated === undefined || toPaise(due.amountDue) !== stated) {
      await this.approval.reject(draftId, userId, due ? 'balance changed since this was drafted' : 'nothing overdue any more');
      await this.prisma.collectionCase.updateMany({ where: { dealerId: draft.dealerId }, data: { lastReminderAt: null, lastReminderLevel: null } });
      throw new BadRequestException(
        due
          ? 'The balance changed since this reminder was drafted, so it was withdrawn — the next run will redraft it from the current figures.'
          : 'This dealer no longer owes anything overdue, so the reminder was withdrawn.',
      );
    }

    const approved = await this.approval.approve(draftId, userId);
    try {
      const event = await this.email.sendApprovedDraft(approved.id);
      return { sent: true, interactionEventId: event.id };
    } catch (err) {
      throw new BadRequestException(`${err instanceof Error ? err.message : String(err)} — the draft stays approved and can be retried.`);
    }
  }

  /** A person has reached the dealer about this; stop flagging them until the interval passes. */
  async acknowledge(dealerId: string) {
    const { count } = await this.prisma.collectionCase.updateMany({ where: { dealerId }, data: { needsCall: false, handledAt: new Date() } });
    if (count === 0) throw new BadRequestException(`no collections case for dealer ${dealerId}`);
  }

  // ---- reads ---------------------------------------------------------------------

  async overview() {
    const settings = await this.settings();
    const now = new Date();
    const [entries, cases, fresh] = await Promise.all([
      this.prisma.paymentLedgerEntry.findMany({ select: { amount: true, paidAmount: true, ageingBucket: true } }),
      this.prisma.collectionCase.findMany({
        where: { level: { not: 'NONE' } },
        orderBy: { outstanding: 'desc' },
        take: 200,
        include: { dealer: { select: { businessName: true, city: true } } },
      }),
      this.sync.freshness(),
    ]);

    const buckets: Record<string, { amount: number; invoices: number }> = {
      CURRENT: { amount: 0, invoices: 0 },
      D30: { amount: 0, invoices: 0 },
      D60: { amount: 0, invoices: 0 },
      D90_PLUS: { amount: 0, invoices: 0 },
    };
    for (const e of entries) {
      const owed = Number(e.amount) - Number(e.paidAmount);
      if (owed <= 0) continue;
      buckets[e.ageingBucket].amount += owed;
      buckets[e.ageingBucket].invoices += 1;
    }
    const stale = await this.staleReason(settings, now);
    return {
      settings,
      paymentsSyncedAt: fresh.payments,
      dataFresh: stale === null,
      staleReason: stale,
      buckets,
      cases: cases.map((c) => ({ ...c, outstanding: Number(c.outstanding) })),
    };
  }
}

export type { EscalationLevel };
