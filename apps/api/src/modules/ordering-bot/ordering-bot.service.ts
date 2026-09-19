// M8 — the ordering bot (§5.9).
//
//   dealer message → command? → build a draft order from EXACT sku matches
//   → reply with the summary and the total → wait for the word CONFIRM
//   → only then an Order (source ORDERING_BOT), in the same table as every import
//
// Deterministic end to end (§1.5): no model reads the dealer's message or writes a reply,
// so there is no path for an invented number. Prices come from Product, totals from
// arithmetic in rules.ts, quantities are echoed back for the dealer to check. Replies go
// out as WhatsApp drafts under a named auto-send rule, so they pass through the same
// consent / 24h-window / kill-switch / staging guards and are logged like any other send.
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { OrderingBotSettings, PrismaClient } from '@prisma/client';
import { ApprovalService } from '../../core/approval';
import { AuditService } from '../../core/audit';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { transitionPipelineStage } from '../outreach-email/pipeline';
import { InboundBot, InboundBotRegistry, InboundBotResult, WHATSAPP_SOURCE_MODULE, WhatsAppSendService, pickWhatsAppNumber } from '../outreach-whatsapp';
import {
  HUMAN_HINT,
  Line,
  catalogText,
  classify,
  clarify,
  inr,
  menuText,
  orderTotalPaise,
  overCap,
  parseOrderText,
  pricesChanged,
  skuIndex,
  summary,
} from './rules';

/** Registered in AppModule's ApprovalModule.forRoot against the WhatsApp source module. */
export const ORDERING_BOT_RULE_ID = 'ordering-bot-scripted';

const MIN = 60_000;
const CATALOG_PAGE = 30;

export type BotSettingsInput = Partial<Pick<OrderingBotSettings, 'enabled' | 'pilotLimit' | 'maxLineQuantity' | 'draftExpiryMinutes'>>;

@Injectable()
export class OrderingBotService implements InboundBot, OnApplicationBootstrap {
  private readonly logger = new Logger(OrderingBotService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: InboundBotRegistry,
    private readonly approval: ApprovalService,
    private readonly sender: WhatsAppSendService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    this.registry.register(this);
  }

  private orgId(): string {
    const id = getOrgId();
    if (!id) throw new Error('tenancy: ordering bot has no org context (§1.3).');
    return id;
  }

  // ---- settings & pilot -----------------------------------------------------------

  async settings(): Promise<OrderingBotSettings> {
    return (await this.prisma.orderingBotSettings.findFirst()) ?? this.prisma.orderingBotSettings.create({ data: { organizationId: this.orgId() } });
  }

  async updateSettings(input: BotSettingsInput): Promise<OrderingBotSettings> {
    const cur = await this.settings();
    for (const k of ['pilotLimit', 'maxLineQuantity', 'draftExpiryMinutes'] as const) {
      const v = input[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new BadRequestException(`${k} must be a whole number, at least 1`);
    }
    return this.prisma.orderingBotSettings.update({
      where: { id: cur.id },
      data: {
        enabled: input.enabled ?? cur.enabled,
        pilotLimit: input.pilotLimit ?? cur.pilotLimit,
        maxLineQuantity: input.maxLineQuantity ?? cur.maxLineQuantity,
        draftExpiryMinutes: input.draftExpiryMinutes ?? cur.draftExpiryMinutes,
      },
    });
  }

  async enroll(dealerId: string): Promise<void> {
    const dealer = await this.prisma.dealer.findFirst({ where: { id: dealerId }, include: { phones: true } });
    if (!dealer) throw new NotFoundException(`no dealer ${dealerId} in this organization`);
    if (!pickWhatsAppNumber(dealer.phones)) throw new BadRequestException(`${dealer.businessName} has no valid WhatsApp number`);
    if (['OPTED_OUT', 'INVALID'].includes(dealer.pipelineStage)) throw new BadRequestException(`${dealer.businessName} cannot be enrolled (${dealer.pipelineStage.toLowerCase()})`);
    if (await this.prisma.orderingBotPilot.findFirst({ where: { dealerId } })) return;
    const s = await this.settings();
    // §5.9 / §16.3: a pilot, not a rollout.
    if ((await this.prisma.orderingBotPilot.count()) >= s.pilotLimit) {
      throw new BadRequestException(`the pilot is capped at ${s.pilotLimit} dealers — raise the limit in settings once it has proven itself`);
    }
    await this.prisma.orderingBotPilot.create({ data: { organizationId: this.orgId(), dealerId } });
  }

  async unenroll(dealerId: string): Promise<void> {
    await this.prisma.orderingBotPilot.deleteMany({ where: { dealerId } });
    await this.prisma.botOrderDraft.updateMany({ where: { dealerId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
  }

  // ---- the conversation -------------------------------------------------------------

  async handle(input: { dealerId: string; text: string }, now: Date = new Date()): Promise<InboundBotResult> {
    const settings = await this.prisma.orderingBotSettings.findFirst();
    if (!settings?.enabled) return { handled: false };
    if (!(await this.prisma.orderingBotPilot.findFirst({ where: { dealerId: input.dealerId } }))) return { handled: false };

    // Lapse stale unconfirmed orders first, so nothing below can confirm one.
    await this.prisma.botOrderDraft.updateMany({ where: { dealerId: input.dealerId, status: 'OPEN', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    const open = await this.prisma.botOrderDraft.findFirst({ where: { dealerId: input.dealerId, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });

    const products = await this.prisma.product.findMany({ where: { active: true }, orderBy: { sku: 'asc' } });
    const parsed = parseOrderText(input.text, skuIndex(products.map((p) => p.sku)));
    const command = classify(input.text, parsed.lines.length);

    switch (command) {
      case 'HUMAN':
        await this.reply(input.dealerId, 'Thank you — a person from our team will get back to you shortly.');
        return { handled: true, needsHuman: true, reason: 'Asked for a person (ordering bot)' };

      case 'CANCEL':
        if (!open) return { handled: false }; // a bare "no" with nothing to cancel is not ours
        await this.prisma.botOrderDraft.update({ where: { id: open.id }, data: { status: 'CANCELLED' } });
        await this.reply(input.dealerId, `Your order was discarded. Send new items any time, like A1 x 10.\n${HUMAN_HINT}`);
        return { handled: true };

      case 'CONFIRM':
        return this.confirm(input.dealerId, open, settings, now);

      case 'MENU':
        await this.reply(input.dealerId, menuText);
        return { handled: true };

      case 'CATALOG':
        await this.reply(input.dealerId, catalogText(products.slice(0, CATALOG_PAGE).map((p) => ({ sku: p.sku, name: p.name, unitPrice: Number(p.unitPrice) })), products.length));
        return { handled: true };

      case 'REORDER':
        return this.reorder(input.dealerId, settings, now);

      case 'ORDER': {
        if (parsed.unclear.length > 0) {
          // Part of the message read, part did not: place nothing, ask about the whole.
          await this.reply(input.dealerId, clarify(parsed.unclear));
          return { handled: true };
        }
        const big = overCap(parsed.lines, settings.maxLineQuantity);
        if (big.length > 0) {
          await this.reply(input.dealerId, `${big.map((b) => `${b.sku} × ${b.quantity}`).join(', ')} is more than I can take by message — a person will check it with you shortly.`);
          return { handled: true, needsHuman: true, reason: `Unusually large quantity (${big.map((b) => `${b.sku} × ${b.quantity}`).join(', ')}) — check before ordering` };
        }
        const bySku = new Map(products.map((p) => [p.sku, p]));
        const lines: Line[] = parsed.lines.map((l) => ({ sku: l.sku, productName: bySku.get(l.sku)!.name, quantity: l.quantity, unitPrice: Number(bySku.get(l.sku)!.unitPrice) }));
        await this.openDraft(input.dealerId, lines, settings, now);
        await this.reply(input.dealerId, summary(lines));
        return { handled: true };
      }

      default:
        return { handled: false }; // not ours — the human inbox keeps it
    }
  }

  private async openDraft(dealerId: string, lines: Line[], settings: OrderingBotSettings, now: Date) {
    // One open order per dealer: a new list replaces the old one, so CONFIRM is never
    // ambiguous about WHICH order.
    await this.prisma.botOrderDraft.updateMany({ where: { dealerId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
    return this.prisma.botOrderDraft.create({
      data: { organizationId: this.orgId(), dealerId, lines: lines as never, expiresAt: new Date(now.getTime() + settings.draftExpiryMinutes * MIN) },
    });
  }

  private async reorder(dealerId: string, settings: OrderingBotSettings, now: Date): Promise<InboundBotResult> {
    const last = await this.prisma.order.findFirst({ where: { dealerId }, orderBy: { orderDate: 'desc' }, include: { lineItems: true } });
    if (!last || last.lineItems.length === 0) {
      await this.reply(dealerId, `I could not find a previous order for you. Send items like A1 x 10, or reply CATALOG.\n${HUMAN_HINT}`);
      return { handled: true };
    }
    const products = await this.prisma.product.findMany({ where: { sku: { in: last.lineItems.map((l) => l.sku) }, active: true } });
    const bySku = new Map(products.map((p) => [p.sku, p]));
    // Quantities are the dealer's own from last time (database); prices are TODAY's.
    const lines: Line[] = [];
    const gone: string[] = [];
    for (const l of last.lineItems) {
      const p = bySku.get(l.sku);
      if (!p) gone.push(l.sku);
      else lines.push({ sku: l.sku, productName: p.name, quantity: Number(l.quantity), unitPrice: Number(p.unitPrice) });
    }
    if (lines.length === 0 || overCap(lines, settings.maxLineQuantity).length > 0) {
      await this.reply(dealerId, 'A person will help you repeat that order shortly.');
      return { handled: true, needsHuman: true, reason: 'Reorder could not be built automatically' };
    }
    await this.openDraft(dealerId, lines, settings, now);
    await this.reply(dealerId, `${summary(lines)}${gone.length ? `\n\nNo longer available, left out: ${gone.join(', ')}.` : ''}`);
    return { handled: true };
  }

  private async confirm(
    dealerId: string,
    open: { id: string; lines: unknown; expiresAt: Date } | null,
    settings: OrderingBotSettings,
    now: Date,
  ): Promise<InboundBotResult> {
    if (!open) {
      await this.reply(dealerId, `There is no order waiting to be confirmed. Send items like A1 x 10 to start one.\n${HUMAN_HINT}`);
      return { handled: true };
    }
    const shown = open.lines as Line[];

    // The prices the dealer confirms must be the prices charged. If the list moved, show
    // the new one and ask again rather than placing an order at a number they never saw.
    const products = await this.prisma.product.findMany({ where: { sku: { in: shown.map((l) => l.sku) } } });
    const current = new Map(products.map((p) => [p.sku, { unitPrice: Number(p.unitPrice), active: p.active }]));
    if (pricesChanged(shown, current)) {
      const refreshed = shown.filter((l) => current.get(l.sku)?.active).map((l) => ({ ...l, unitPrice: current.get(l.sku)!.unitPrice }));
      if (refreshed.length === 0) {
        await this.prisma.botOrderDraft.update({ where: { id: open.id }, data: { status: 'CANCELLED' } });
        await this.reply(dealerId, `Those items are no longer available. A person will help you shortly.`);
        return { handled: true, needsHuman: true, reason: 'Items on the open order are no longer available' };
      }
      await this.openDraft(dealerId, refreshed, settings, now);
      await this.reply(dealerId, `Prices or availability changed since I showed you this order, so please check it again.\n\n${summary(refreshed)}`);
      return { handled: true };
    }

    const totalPaise = orderTotalPaise(shown);
    const orgId = this.orgId();
    // One transaction: the OPEN → CONFIRMED flip is conditional, so a redelivered CONFIRM
    // (or two fast ones) can create the order once and only once.
    const orderId = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.botOrderDraft.updateMany({ where: { id: open.id, status: 'OPEN' }, data: { status: 'CONFIRMED' } });
      if (count === 0) return null;
      const order = await tx.order.create({
        data: {
          organizationId: orgId,
          dealerId,
          externalRef: `BOT-${open.id}`,
          orderDate: now,
          totalValue: (totalPaise / 100).toFixed(2),
          source: 'ORDERING_BOT',
          lineItems: {
            create: shown.map((l) => ({
              organizationId: orgId,
              sku: l.sku,
              productName: l.productName,
              quantity: l.quantity,
              unitPrice: l.unitPrice.toFixed(2),
              lineTotal: ((Math.round(l.unitPrice * 100) * l.quantity) / 100).toFixed(2),
            })),
          },
        },
      });
      await tx.botOrderDraft.update({ where: { id: open.id }, data: { orderId: order.id } });
      return order.id;
    });
    if (!orderId) return { handled: true }; // already confirmed by an earlier delivery

    // A dealer who has just ordered is active. Conditional, so it never moves anyone backwards.
    await transitionPipelineStage(this.prisma, this.audit, { organizationId: orgId, dealerId, from: 'ONBOARDED', to: 'ACTIVE', reason: 'Order placed via the ordering bot (§5.9)' });

    await this.reply(dealerId, `Thank you — your order for ${inr(totalPaise)} is placed. Our team will confirm dispatch with you.\n${HUMAN_HINT}`);
    return { handled: true };
  }

  // ---- sending -------------------------------------------------------------------------

  /** A scripted reply, through the shared draft → auto-send → guarded send path. Failure
   *  is logged and swallowed: the state change it reports has already been saved. */
  private async reply(dealerId: string, text: string): Promise<void> {
    try {
      const draft = await this.prisma.messageDraft.create({
        data: {
          organizationId: this.orgId(),
          dealerId,
          sourceModule: WHATSAPP_SOURCE_MODULE,
          draftText: text,
          templateVariables: { kind: 'freeform', bot: true } as never,
          containsFinancialTerms: true,
          requiresApproval: false,
          autoSendRuleId: ORDERING_BOT_RULE_ID,
        },
      });
      await this.approval.autoSend(draft.id);
      await this.sender.sendApprovedDraft(draft.id);
    } catch (err) {
      this.logger.error(`bot reply to ${dealerId} not sent: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---- reads ---------------------------------------------------------------------------

  async overview() {
    const [settings, pilot, drafts, orders] = await Promise.all([
      this.settings(),
      this.prisma.orderingBotPilot.findMany({ orderBy: { enrolledAt: 'asc' }, include: { dealer: { select: { businessName: true, city: true } } } }),
      this.prisma.botOrderDraft.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.findMany({
        where: { source: 'ORDERING_BOT' },
        orderBy: { orderDate: 'desc' },
        take: 30,
        include: { dealer: { select: { businessName: true } }, lineItems: { select: { sku: true, productName: true, quantity: true } } },
      }),
    ]);
    const count = (s: string) => drafts.find((d) => d.status === s)?._count._all ?? 0;
    return {
      settings,
      pilot: pilot.map((p) => ({ dealerId: p.dealerId, businessName: p.dealer.businessName, city: p.dealer.city, enrolledAt: p.enrolledAt })),
      // The pilot's proof (§15): of orders started in chat, how many finished.
      funnel: { started: drafts.reduce((n, d) => n + d._count._all, 0), confirmed: count('CONFIRMED'), cancelled: count('CANCELLED'), expired: count('EXPIRED'), open: count('OPEN') },
      orders: orders.map((o) => ({ id: o.id, dealerId: o.dealerId, businessName: o.dealer.businessName, orderDate: o.orderDate, totalValue: Number(o.totalValue), lines: o.lineItems.map((l) => ({ sku: l.sku, productName: l.productName, quantity: Number(l.quantity) })) })),
    };
  }
}
