// M6 — schemes (§5.7).
//
//   create (DRAFT) → preview the audience → activate: snapshot who it targets
//   → broadcast: one drafted announcement per eligible dealer, ALWAYS to the approval queue
//     (scheme terms are financial commitments)
//   → attribute: orders in the window, from a targeted dealer, on a scheme product,
//     get schemeId — "the attribution is the value of this module"
//
// The scheme's terms are the owner's own words, injected verbatim from the database (§1.4);
// the model writes only the sentence around them.
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, Scheme } from '@prisma/client';
import { ApprovalService } from '../../core/approval';
import { AuditAction, AuditService } from '../../core/audit';
import { DraftingService, date, name, template } from '../../core/drafting';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { currentConsentState, isEligibleForEmail } from '../outreach-email/consent';
import { renderPlain } from '../outreach-email/cold-draft.service';
import { EmailSendService, isPlausibleEmail } from '../outreach-email/send.service';
import { DAY_MS, SegmentRule, attributeOrder, matchesSegment, validateRule, validateWindow } from './rules';

export const SCHEMES_SOURCE_MODULE = 'schemes';

const ANNOUNCEMENT = template(
  'Hi {{contactName}},\n\n' +
    'We have a new scheme at {{ourBusinessName}} that we thought {{businessName}} would want to hear about: {{schemeName}}.\n\n' +
    'The terms: {{terms}}\n\n' +
    'It runs from {{validFrom}} to {{validTo}}. If you would like to take it up, or have any questions, just reply to this message.\n\n' +
    'Warm regards,\n{{ourBusinessName}}',
);
const SUBJECT = 'A new scheme for {{businessName}}: {{schemeName}}';

export type SchemeInput = {
  name?: string;
  description?: string | null;
  terms?: string;
  applicableProductIds?: string[];
  validFrom?: string;
  validTo?: string;
  targetSegmentRule?: SegmentRule;
};

export type BroadcastResult = { dryRun: boolean; drafted: number; alreadyDrafted: number; skipped: { dealerId: string; businessName: string; reason: string }[] };

@Injectable()
export class SchemesService {
  private readonly logger = new Logger(SchemesService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly drafting: DraftingService,
    private readonly approval: ApprovalService,
    private readonly audit: AuditService,
    private readonly email: EmailSendService,
  ) {}

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: schemes has no org context (§1.3).');
    return id;
  }

  private async load(id: string): Promise<Scheme> {
    const s = await this.prisma.scheme.findFirst({ where: { id } });
    if (!s) throw new NotFoundException(`no scheme ${id}`);
    return s;
  }

  // ---- CRUD ---------------------------------------------------------------------------

  private async validated(input: SchemeInput, cur?: Scheme) {
    const nameV = (input.name ?? cur?.name ?? '').trim();
    const terms = (input.terms ?? cur?.terms ?? '').trim();
    if (!nameV) throw new BadRequestException('a scheme needs a name');
    if (!terms) throw new BadRequestException('a scheme needs its terms — the exact wording dealers will be shown');
    const from = new Date(input.validFrom ?? cur?.validFrom ?? '');
    const to = new Date(input.validTo ?? cur?.validTo ?? '');
    const bad = validateWindow(from, to);
    if (bad) throw new BadRequestException(bad);
    const rule = input.targetSegmentRule ?? (cur?.targetSegmentRule as SegmentRule | undefined) ?? {};
    const ruleBad = validateRule(rule);
    if (ruleBad) throw new BadRequestException(ruleBad);
    const productIds = input.applicableProductIds ?? cur?.applicableProductIds ?? [];
    if (productIds.length === 0) throw new BadRequestException('pick at least one product — attribution matches orders on them');
    const found = await this.prisma.product.count({ where: { id: { in: productIds } } });
    if (found !== new Set(productIds).size) throw new BadRequestException('one or more products do not exist');
    return {
      name: nameV,
      description: input.description === undefined ? cur?.description ?? null : input.description?.trim() || null,
      terms,
      applicableProductIds: [...new Set(productIds)],
      validFrom: from,
      validTo: to,
      targetSegmentRule: rule as unknown as Prisma.InputJsonValue,
    };
  }

  async create(input: SchemeInput): Promise<Scheme> {
    return this.prisma.scheme.create({ data: { organizationId: this.orgId(), ...(await this.validated(input)) } });
  }

  async update(id: string, input: SchemeInput): Promise<Scheme> {
    const cur = await this.load(id);
    // Once recipients are snapshotted and messages drafted, changing the terms would make
    // the announcement say one thing and the scheme another.
    if (cur.status !== 'DRAFT') throw new BadRequestException('only a draft scheme can be edited — end it and create a new one');
    return this.prisma.scheme.update({ where: { id }, data: await this.validated(input, cur) });
  }

  async remove(id: string): Promise<void> {
    const cur = await this.load(id);
    if (cur.status !== 'DRAFT') throw new BadRequestException('only a draft scheme can be deleted');
    await this.prisma.scheme.delete({ where: { id } });
  }

  // ---- audience ----------------------------------------------------------------------

  private async audience(s: Scheme, now: Date) {
    const rule = s.targetSegmentRule as SegmentRule;
    const products = await this.prisma.product.findMany({ where: { id: { in: s.applicableProductIds } }, select: { sku: true } });
    const skus = products.map((p) => p.sku);
    const [dealers, lines] = await Promise.all([
      this.prisma.dealer.findMany({
        where: { pipelineStage: { notIn: ['OPTED_OUT', 'INVALID'] } },
        select: { id: true, businessName: true, pipelineStage: true, businessCategory: true, state: true, city: true },
      }),
      rule.boughtSchemeProductsWithinDays !== undefined
        ? this.prisma.orderLineItem.findMany({ where: { sku: { in: skus } }, select: { order: { select: { dealerId: true, orderDate: true } } } })
        : Promise.resolve([]),
    ]);
    const lastBought = new Map<string, Date>();
    for (const l of lines) {
      const cur = lastBought.get(l.order.dealerId);
      if (!cur || l.order.orderDate > cur) lastBought.set(l.order.dealerId, l.order.orderDate);
    }
    return dealers.filter((d) => matchesSegment({ ...d, lastBoughtSchemeProductAt: lastBought.get(d.id) ?? null }, rule, now));
  }

  /** Who a scheme would target right now — a look, changes nothing. */
  async preview(id: string) {
    const s = await this.load(id);
    const targets = await this.audience(s, new Date());
    return { count: targets.length, sample: targets.slice(0, 20).map((d) => ({ dealerId: d.id, businessName: d.businessName, city: d.city })) };
  }

  // ---- lifecycle ---------------------------------------------------------------------

  /** DRAFT → ACTIVE, snapshotting the audience. From here the scheme is fixed. */
  async activate(id: string, userId: string): Promise<{ recipients: number }> {
    const s = await this.load(id);
    if (s.status !== 'DRAFT') throw new BadRequestException(`this scheme is already ${s.status.toLowerCase()}`);
    if (s.validTo.getTime() + DAY_MS <= Date.now()) throw new BadRequestException('this scheme has already ended — change its dates first');
    const targets = await this.audience(s, new Date());
    if (targets.length === 0) throw new BadRequestException('no dealers match this segment, so nobody would be told about it');
    const orgId = this.orgId();
    await this.prisma.schemeRecipient.createMany({ data: targets.map((d) => ({ organizationId: orgId, schemeId: s.id, dealerId: d.id })), skipDuplicates: true });
    await this.prisma.scheme.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
    await this.audit.record({
      actorType: 'USER',
      actorId: userId,
      organizationId: orgId,
      entityType: 'Scheme',
      entityId: id,
      action: AuditAction.SCHEME_ACTIVATED,
      metadata: { recipients: targets.length },
    });
    return { recipients: targets.length };
  }

  async end(id: string, userId: string): Promise<void> {
    const s = await this.load(id);
    if (s.status !== 'ACTIVE') throw new BadRequestException('only an active scheme can be ended');
    await this.prisma.scheme.update({ where: { id }, data: { status: 'ENDED' } });
    // Announcements still waiting for approval are now announcing something withdrawn.
    const recs = await this.prisma.schemeRecipient.findMany({ where: { schemeId: id, draftId: { not: null } }, select: { draftId: true } });
    const pending = await this.prisma.messageDraft.findMany({ where: { id: { in: recs.map((r) => r.draftId!) }, status: 'PENDING' }, select: { id: true } });
    for (const d of pending) await this.approval.reject(d.id, userId, 'scheme ended');
    await this.audit.record({ actorType: 'USER', actorId: userId, organizationId: this.orgId(), entityType: 'Scheme', entityId: id, action: AuditAction.SCHEME_ENDED });
  }

  // ---- broadcast ---------------------------------------------------------------------

  /** Draft an announcement for every targeted dealer not yet drafted. Idempotent: run it
   *  twice and nobody gets two. Everything lands in the approval queue. */
  async broadcast(id: string, opts: { dryRun?: boolean } = {}): Promise<BroadcastResult> {
    const s = await this.load(id);
    if (s.status !== 'ACTIVE') throw new BadRequestException('activate the scheme before announcing it');
    if (s.validTo.getTime() + DAY_MS <= Date.now()) throw new BadRequestException('this scheme has already ended');
    const dryRun = opts.dryRun === true;
    const result: BroadcastResult = { dryRun, drafted: 0, alreadyDrafted: 0, skipped: [] };

    const recipients = await this.prisma.schemeRecipient.findMany({ where: { schemeId: id }, include: { dealer: { include: { emails: true } } } });
    const org = await this.prisma.organization.findFirst({ select: { name: true } });

    for (const r of recipients) {
      const dealer = r.dealer;
      if (r.draftId) {
        result.alreadyDrafted += 1;
        continue;
      }
      // Re-checked at broadcast time: consent may have changed since activation.
      if (['OPTED_OUT', 'INVALID'].includes(dealer.pipelineStage) || !isEligibleForEmail(await currentConsentState(this.prisma, dealer.id, 'EMAIL'))) {
        result.skipped.push({ dealerId: dealer.id, businessName: dealer.businessName, reason: 'opted out of email' });
        continue;
      }
      const address = (dealer.emails.find((e) => e.isPrimary) ?? dealer.emails[0])?.address;
      if (!address || !isPlausibleEmail(address)) {
        result.skipped.push({ dealerId: dealer.id, businessName: dealer.businessName, reason: 'no usable email address' });
        continue;
      }
      if (dryRun) {
        result.drafted += 1;
        continue;
      }
      const draft = await this.drafting.draft({
        dealerId: dealer.id,
        sourceModule: SCHEMES_SOURCE_MODULE,
        template: ANNOUNCEMENT,
        variables: {
          contactName: name(dealer.contactPersonName ?? 'Sir/Madam'),
          businessName: name(dealer.businessName),
          ourBusinessName: name(org?.name ?? ''),
          schemeName: name(s.name),
          // The owner's exact words, from the database column — never model output (§1.4).
          terms: name(s.terms),
          validFrom: date(s.validFrom),
          validTo: date(s.validTo),
        },
      });
      // Scheme terms are commitments: never auto-sent, whatever the drafting flags say (§5.7).
      await this.prisma.messageDraft.update({
        where: { id: draft.id },
        data: { subject: renderPlain(SUBJECT, { businessName: dealer.businessName, schemeName: s.name }), requiresApproval: true, autoSendRuleId: null },
      });
      await this.prisma.schemeRecipient.update({ where: { id: r.id }, data: { draftId: draft.id } });
      result.drafted += 1;
    }
    return result;
  }

  /**
   * A queued announcement can sit for days. If the scheme has since ended or lapsed it is
   * withdrawn rather than sent — telling a dealer about a scheme that is over is worse than
   * silence.
   */
  async approveAndSend(draftId: string, userId: string) {
    const rec = await this.prisma.schemeRecipient.findFirst({ where: { draftId }, include: { scheme: true } });
    if (!rec) throw new BadRequestException(`no scheme announcement ${draftId}`);
    const live = rec.scheme.status === 'ACTIVE' && rec.scheme.validTo.getTime() + DAY_MS > Date.now();
    if (!live) {
      await this.approval.reject(draftId, userId, 'scheme is no longer running');
      throw new BadRequestException('This scheme is no longer running, so the announcement was withdrawn.');
    }
    const approved = await this.approval.approve(draftId, userId);
    try {
      const event = await this.email.sendApprovedDraft(approved.id);
      return { sent: true, interactionEventId: event.id };
    } catch (err) {
      throw new BadRequestException(`${err instanceof Error ? err.message : String(err)} — the draft stays approved and can be retried.`);
    }
  }

  // ---- attribution ------------------------------------------------------------------

  /** Tags untagged orders that match a running or finished scheme. Never re-tags. */
  async attribute(): Promise<{ tagged: number }> {
    const schemes = await this.prisma.scheme.findMany({ where: { status: { in: ['ACTIVE', 'ENDED'] } }, include: { recipients: { select: { dealerId: true } } } });
    if (schemes.length === 0) return { tagged: 0 };
    const products = await this.prisma.product.findMany({ where: { id: { in: schemes.flatMap((s) => s.applicableProductIds) } }, select: { id: true, sku: true } });
    const skuOf = new Map(products.map((p) => [p.id, p.sku]));
    const facts = schemes.map((s) => ({
      id: s.id,
      validFrom: s.validFrom,
      validTo: s.validTo,
      skus: new Set(s.applicableProductIds.map((p) => skuOf.get(p)).filter((x): x is string => !!x)),
      targetDealerIds: new Set(s.recipients.map((r) => r.dealerId)),
    }));
    const from = new Date(Math.min(...schemes.map((s) => s.validFrom.getTime())));
    const to = new Date(Math.max(...schemes.map((s) => s.validTo.getTime())) + DAY_MS);
    const orders = await this.prisma.order.findMany({
      where: { schemeId: null, orderDate: { gte: from, lte: to } },
      select: { id: true, dealerId: true, orderDate: true, lineItems: { select: { sku: true } } },
    });
    const bySchemeId = new Map<string, string[]>();
    for (const o of orders) {
      const hit = attributeOrder({ dealerId: o.dealerId, orderDate: o.orderDate, skus: o.lineItems.map((l) => l.sku) }, facts);
      if (hit) bySchemeId.set(hit, [...(bySchemeId.get(hit) ?? []), o.id]);
    }
    let tagged = 0;
    for (const [schemeId, ids] of bySchemeId) {
      // schemeId: null in the filter keeps a concurrent tagger from being overwritten.
      tagged += (await this.prisma.order.updateMany({ where: { id: { in: ids }, schemeId: null }, data: { schemeId } })).count;
    }
    return { tagged };
  }

  // ---- reads --------------------------------------------------------------------------

  async list() {
    const schemes = await this.prisma.scheme.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { recipients: { select: { dealerId: true, draftId: true } } } });
    const draftIds = schemes.flatMap((s) => s.recipients.map((r) => r.draftId)).filter((x): x is string => !!x);
    const sent = new Set((await this.prisma.messageDraft.findMany({ where: { id: { in: draftIds }, sentAt: { not: null } }, select: { id: true } })).map((d) => d.id));
    const orders = await this.prisma.order.groupBy({ by: ['schemeId', 'dealerId'], where: { schemeId: { in: schemes.map((s) => s.id) } }, _sum: { totalValue: true }, _count: { _all: true } });
    return schemes.map((s) => {
      const mine = orders.filter((o) => o.schemeId === s.id);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        terms: s.terms,
        status: s.status,
        validFrom: s.validFrom,
        validTo: s.validTo,
        applicableProductIds: s.applicableProductIds,
        targetSegmentRule: s.targetSegmentRule,
        targeted: s.recipients.length,
        announced: s.recipients.filter((r) => r.draftId && sent.has(r.draftId)).length,
        attributedOrders: mine.reduce((n, o) => n + o._count._all, 0),
        attributedRevenue: mine.reduce((n, o) => n + Number(o._sum.totalValue ?? 0), 0),
        dealersWhoOrdered: mine.length,
      };
    });
  }

  products() {
    return this.prisma.product.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, sku: true, name: true, category: true }, take: 500 });
  }
}
