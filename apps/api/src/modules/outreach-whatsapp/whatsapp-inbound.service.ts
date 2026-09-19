import { Inject, Injectable, Logger } from '@nestjs/common';
import { InteractionStatus, Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../../core/audit';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { WHATSAPP_PROVIDER, WhatsAppProvider, WhatsAppWebhookEvent } from '../../providers/whatsapp';
import { normalizePhone } from '../contacts/normalize';
import { currentConsentState, writeConsent } from '../outreach-email/consent';
import { transitionPipelineStage } from '../outreach-email/pipeline';
import { SequenceService } from '../outreach-email/sequence.service';
import { InboundBotRegistry } from './inbound-bot.registry';
import { classifyIntent, fromWaId, isPositiveIntent, nextConversation, sessionExpiryFrom } from './rules';

type ByPhoneNumber = { phoneNumberId: string };
type ByWaba = { wabaId: string };

const STATUS_MAP: Record<'DELIVERED' | 'READ' | 'FAILED', InteractionStatus> = {
  DELIVERED: 'DELIVERED',
  READ: 'OPENED',
  FAILED: 'FAILED',
};

/**
 * §5.3 / §8 — everything Meta tells us. Same shape as the email webhooks and the SAME
 * failure discipline: the WebhookEvent idempotency row is written first, and if the real
 * work then fails it is deleted, so the provider's retry can actually retry. (The email
 * handlers shipped without that and silently lost a real reply once — a row that says
 * "seen" while nothing was recorded is worse than no row.)
 */
@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
    private readonly bots: InboundBotRegistry,
  ) {}

  /** Throws (→ 4xx, no retry wanted) if the signature does not verify; per-event failures
   *  propagate so a transient error is retried by Meta. */
  async handle(rawBody: Buffer, headers: Record<string, string>): Promise<{ events: number }> {
    const events = this.whatsapp.parseWebhook(rawBody, headers);
    for (const event of events) await this.processOne(event);
    return { events: events.length };
  }

  private idempotencyKey(e: WhatsAppWebhookEvent): string {
    switch (e.type) {
      case 'MESSAGE':
        return `msg:${e.providerMessageId}`;
      case 'STATUS':
        return `status:${e.providerMessageId}:${e.status}`;
      case 'TEMPLATE':
        return `tpl:${e.metaTemplateId}:${e.status}`;
      case 'QUALITY':
        // Meta sends no id for these and a second FLAGGED later is real — bucket by minute
        // so a redelivery collapses but a genuine repeat does not.
        return `quality:${e.phoneNumberId}:${e.event}:${e.tier ?? ''}:${Math.floor(Date.now() / 60_000)}`;
    }
  }

  private async processOne(e: WhatsAppWebhookEvent): Promise<void> {
    const providerEventId = this.idempotencyKey(e);
    try {
      // Unscoped by design: a webhook arrives before any org context exists (tenancy.ts).
      await this.prisma.webhookEvent.create({ data: { provider: 'whatsapp', providerEventId, payload: e as never } });
    } catch (err: any) {
      if (err?.code === 'P2002') return; // already processed (§8)
      throw err;
    }
    const key = { provider_providerEventId: { provider: 'whatsapp', providerEventId } };
    try {
      await this.dispatch(e);
      await this.prisma.webhookEvent.update({ where: key, data: { processedAt: new Date() } });
    } catch (err) {
      await this.prisma.webhookEvent.delete({ where: key }).catch(() => {});
      throw err;
    }
  }

  /**
   * Which org owns this number? Inherently a bootstrap lookup: the webhook names only the
   * business phone-number id (or WABA id), so no tenant context can exist yet. tenancy.ts
   * refuses tenant tables without one, so this is raw SQL against the routing table — the
   * same justification as DedupService's fuzzy match and email's reply threading.
   */
  private async orgFor(by: ByPhoneNumber | ByWaba): Promise<string | null> {
    const rows =
      'phoneNumberId' in by
        ? await this.prisma.$queryRaw<{ organizationId: string }[]>`SELECT "organizationId" FROM "WhatsAppAccount" WHERE "phoneNumberId" = ${by.phoneNumberId} LIMIT 1`
        : await this.prisma.$queryRaw<{ organizationId: string }[]>`SELECT "organizationId" FROM "WhatsAppAccount" WHERE "wabaId" = ${by.wabaId} LIMIT 1`;
    return rows[0]?.organizationId ?? null;
  }

  private async dispatch(e: WhatsAppWebhookEvent): Promise<void> {
    const orgId = await this.orgFor(e.type === 'TEMPLATE' ? { wabaId: e.wabaId } : { phoneNumberId: e.phoneNumberId });
    if (!orgId) {
      // Not an error to retry: this number is not linked to any organization.
      this.logger.warn(`WhatsApp ${e.type} for a number no organization owns — ignored`);
      return;
    }
    await runWithOrg(orgId, async () => {
      switch (e.type) {
        case 'MESSAGE':
          return this.onMessage(orgId, e);
        case 'STATUS':
          return this.onStatus(e);
        case 'TEMPLATE':
          return this.onTemplate(e);
        case 'QUALITY':
          return this.onQuality(e);
      }
    });
  }

  // ---- an inbound message -------------------------------------------------------

  private async onMessage(orgId: string, e: Extract<WhatsAppWebhookEvent, { type: 'MESSAGE' }>) {
    const e164 = fromWaId(e.from);
    const phone = await this.prisma.dealerPhone.findFirst({ where: { e164 }, orderBy: { id: 'asc' } });

    let dealerId: string;
    if (phone) {
      dealerId = phone.dealerId;
    } else {
      // Someone we have never heard of messaged the business number first (§7: that
      // makes them warm). They become a dealer at source INQUIRY — the value exists for
      // exactly this — with the consent their own message gives us for this channel.
      const norm = normalizePhone(e164);
      const created = await this.prisma.dealer.create({
        data: {
          organizationId: orgId,
          businessName: e.profileName?.trim() || e164,
          source: 'INQUIRY',
          pipelineStage: 'NEW',
          dedupeKey: `p:${e164}`,
          phones: { create: [{ raw: e164, e164: norm.e164 ?? e164, valid: norm.valid, isPrimary: true, isWhatsapp: true }] },
          consentLogs: {
            create: [
              { channel: 'EMAIL', state: 'UNKNOWN', source: 'IMPORT_DEFAULT' },
              { channel: 'CALL', state: 'UNKNOWN', source: 'IMPORT_DEFAULT' },
            ],
          },
        },
      });
      dealerId = created.id;
    }

    const intent = classifyIntent(e.text);
    const next = nextConversation(intent);

    // Not atomic with the rest of this method, so a retry after a partial failure lands
    // here again — keyed on Meta's own message id so it cannot double-record the message.
    const seen = await this.prisma.interactionEvent.findFirst({
      where: { channel: 'WHATSAPP', direction: 'INBOUND', providerMessageId: e.providerMessageId },
      select: { id: true },
    });
    if (!seen) {
      await this.prisma.interactionEvent.create({
        data: {
          dealerId,
          channel: 'WHATSAPP',
          direction: 'INBOUND',
          providerMessageId: e.providerMessageId,
          status: 'REPLIED',
          body: e.text,
        } as Prisma.InteractionEventUncheckedCreateInput,
      });
    }

    // The 24h window opens (or renews) on THEIR message; never shortened by a late redelivery.
    const existing = await this.prisma.whatsAppConversation.findFirst({ where: { dealerId } });
    const expiry = sessionExpiryFrom(e.at);
    const sessionExpiresAt = existing?.sessionExpiresAt && existing.sessionExpiresAt > expiry ? existing.sessionExpiresAt : expiry;
    const data = {
      phoneE164: e164,
      lastInboundAt: e.at,
      sessionExpiresAt,
      state: next.state,
      needsHuman: next.needsHuman,
      humanReason: next.reason,
    };
    if (existing) await this.prisma.whatsAppConversation.update({ where: { id: existing.id }, data });
    else await this.prisma.whatsAppConversation.create({ data: { ...data, organizationId: orgId, dealerId } as never });

    // Consent, per channel and append-only (§1.6). STOP is an opt-out. Anything else is
    // the dealer choosing to talk to us on this channel, which is what INBOUND_MESSAGE
    // records — including a dealer who opted out earlier and now writes again (the
    // history stays; the latest row wins, §10.2).
    const consent = await currentConsentState(this.prisma, dealerId, 'WHATSAPP');
    if (intent === 'STOP') {
      if (consent !== 'OPTED_OUT') {
        await writeConsent(this.prisma, { organizationId: orgId, dealerId, channel: 'WHATSAPP', state: 'OPTED_OUT', source: 'EXPLICIT_UNSUBSCRIBE' });
      }
    } else if (consent !== 'OPTED_IN') {
      await writeConsent(this.prisma, { organizationId: orgId, dealerId, channel: 'WHATSAPP', state: 'OPTED_IN', source: 'INBOUND_MESSAGE' });
    }

    // A reply on any channel halts the email follow-up sequence (§6).
    await this.sequence.cancel(orgId, dealerId);

    // Pipeline (§5.3): any engagement NEW → CONTACTED; a positive signal → INTERESTED.
    if (intent !== 'STOP') {
      await transitionPipelineStage(this.prisma, this.audit, {
        organizationId: orgId, dealerId, from: 'NEW', to: 'CONTACTED', reason: 'WhatsApp message received (§5.3)',
      });
      if (isPositiveIntent(intent)) {
        await transitionPipelineStage(this.prisma, this.audit, {
          organizationId: orgId, dealerId, from: 'CONTACTED', to: 'INTERESTED', reason: `WhatsApp ${intent.toLowerCase()} signal (§5.3)`,
        });
      }
    }

    // An enrolled ordering-bot dealer (M8) gets a scripted reply. Runs last, after the
    // window and consent are recorded, because the reply goes out through the same guards.
    // Whatever the bot handled is not the human inbox's to chase — unless it asked for one.
    if (intent !== 'STOP') {
      const result = await this.bots.dispatch({ dealerId, text: e.text });
      if (result.handled) {
        await this.prisma.whatsAppConversation.updateMany({
          where: { dealerId },
          data: { needsHuman: result.needsHuman === true, humanReason: result.needsHuman ? result.reason ?? 'Asked for a person' : null, state: result.needsHuman ? 'HUMAN' : 'IDLE' },
        });
      }
    }
  }

  // ---- delivery status ----------------------------------------------------------

  private async onStatus(e: Extract<WhatsAppWebhookEvent, { type: 'STATUS' }>) {
    if (e.status === 'SENT') return; // recorded at send time
    const original = await this.prisma.interactionEvent.findFirst({
      where: { channel: 'WHATSAPP', direction: 'OUTBOUND', providerMessageId: e.providerMessageId },
      orderBy: { createdAt: 'asc' },
    });
    if (!original) return; // not a message this app sent (e.g. sent from the Business app)
    await this.prisma.interactionEvent.create({
      data: {
        dealerId: original.dealerId,
        channel: 'WHATSAPP',
        direction: 'OUTBOUND',
        messageDraftId: original.messageDraftId,
        providerMessageId: e.providerMessageId,
        status: STATUS_MAP[e.status],
        errorText: e.error,
        body: '',
      } as Prisma.InteractionEventUncheckedCreateInput,
    });
  }

  // ---- templates & quality ------------------------------------------------------

  private async onTemplate(e: Extract<WhatsAppWebhookEvent, { type: 'TEMPLATE' }>) {
    await this.prisma.whatsAppTemplate.updateMany({
      where: { OR: [{ metaTemplateId: e.metaTemplateId }, ...(e.name ? [{ name: e.name, metaTemplateId: null }] : [])] },
      data: { status: e.status, rejectionReason: e.reason, metaTemplateId: e.metaTemplateId || undefined },
    });
  }

  private async onQuality(e: Extract<WhatsAppWebhookEvent, { type: 'QUALITY' }>) {
    // §7 / §10.3: a quality drop auto-pauses BROADCASTS. It does not touch replies inside a
    // live session, and it never auto-resumes — a person looks at why first.
    const drop = ['FLAGGED', 'DOWNGRADE'].includes(e.event.toUpperCase());
    await this.prisma.whatsAppAccount.updateMany({
      data: { qualityEvent: e.event, messagingTier: e.tier, ...(drop ? { broadcastsPausedByQuality: true } : {}) },
    });
    if (drop) this.logger.warn(`WhatsApp quality ${e.event} — marketing broadcasts auto-paused for the organization`);
  }
}
