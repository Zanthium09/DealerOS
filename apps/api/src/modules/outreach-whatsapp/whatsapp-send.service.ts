import { Inject, Injectable } from '@nestjs/common';
import { InteractionEvent, Prisma, PrismaClient } from '@prisma/client';
import { KillSwitchService } from '../../core/killswitch';
import { assertSendAllowed } from '../../core/killswitch/staging-guard';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { WHATSAPP_PROVIDER, WhatsAppProvider } from '../../providers/whatsapp';
import { currentConsentState } from '../outreach-email/consent';
import { pickWhatsAppNumber, warmSignalsFor } from './eligibility';
import { isWarm, paramsFor, renderTemplate, sessionOpen } from './rules';

export const SOURCE_MODULE = 'outreach-whatsapp';

export class WhatsAppSendError extends Error {}

/** What a WhatsApp MessageDraft carries in `templateVariables` — the whole instruction,
 *  so "what exactly did we send, and how" is answerable from the row alone. */
export type WhatsAppDraftPayload =
  | { kind: 'template'; templateId: string; params: string[] }
  | { kind: 'freeform'; human?: true };

/**
 * §5.3 / §7 — takes an APPROVED WhatsApp draft and sends it. Every rule here is a hard
 * stop that throws, never a warning and never a quiet fallback:
 *
 *   - freeform outside an open 24h session is REJECTED, not downgraded to a template
 *   - a dealer who is not warm cannot be messaged, however the draft got here
 *   - an opted-out dealer cannot be messaged
 *   - marketing templates stop while the number's quality has auto-paused broadcasts
 *   - a template must be APPROVED by Meta
 */
@Injectable()
export class WhatsAppSendService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    private readonly killSwitch: KillSwitchService,
  ) {}

  async sendApprovedDraft(draftId: string, now: Date = new Date()): Promise<InteractionEvent> {
    const draft = await this.prisma.messageDraft.findFirst({ where: { id: draftId } });
    if (!draft) throw new WhatsAppSendError(`no draft ${draftId} in this organization`);
    if (draft.sourceModule !== SOURCE_MODULE) {
      throw new WhatsAppSendError(`draft ${draftId} belongs to ${draft.sourceModule}, not ${SOURCE_MODULE}`);
    }
    if (draft.status !== 'APPROVED') {
      throw new WhatsAppSendError(`draft ${draftId} is ${draft.status}, not APPROVED — it cannot be sent (§9)`);
    }
    const payload = draft.templateVariables as unknown as WhatsAppDraftPayload;
    if (!payload || (payload.kind !== 'template' && payload.kind !== 'freeform')) {
      throw new WhatsAppSendError(`draft ${draftId} has no WhatsApp send instruction`);
    }

    // §12.6 — global switch, and this org's own.
    const [settings, account] = await Promise.all([
      this.prisma.outreachSettings.findFirst(),
      this.prisma.whatsAppAccount.findFirst(),
    ]);
    if ((await this.killSwitch.isPaused('WHATSAPP')) || settings?.whatsappPaused) {
      throw new WhatsAppSendError('WhatsApp sending is paused (§12.6)');
    }

    const dealer = await this.prisma.dealer.findFirst({ where: { id: draft.dealerId }, include: { phones: true } });
    if (!dealer) throw new WhatsAppSendError(`dealer ${draft.dealerId} not found`);

    // §1.2 / §7 — warm-routing as a guard on the send itself, and consent per channel.
    const consent = await currentConsentState(this.prisma, dealer.id, 'WHATSAPP');
    if (consent === 'OPTED_OUT') throw new WhatsAppSendError(`dealer ${dealer.id} is WhatsApp opted out — refusing to send (§10.2)`);
    if (!isWarm(await warmSignalsFor(this.prisma, dealer))) {
      throw new WhatsAppSendError(
        `${dealer.businessName} has not engaged yet — WhatsApp is the warm channel (§1.2). ` +
          'Reach them by email first; they become eligible when they reply, click, message us, or opt in.',
      );
    }

    const to = pickWhatsAppNumber(dealer.phones);
    if (!to) throw new WhatsAppSendError(`${dealer.businessName} has no valid phone number`);
    assertSendAllowed({ phoneE164: to }); // §12.7 — a code-level guard outside production

    const conversation = await this.prisma.whatsAppConversation.findFirst({ where: { dealerId: dealer.id } });
    const inSession = sessionOpen(conversation?.sessionExpiresAt, now);

    let template = null as Awaited<ReturnType<PrismaClient['whatsAppTemplate']['findFirst']>>;
    if (payload.kind === 'freeform') {
      // §7: "Reject freeform outside a session — fail loudly, never silently fall back."
      if (!inSession) {
        throw new WhatsAppSendError(
          `the 24-hour window with ${dealer.businessName} is closed — WhatsApp only allows an approved template now. ` +
            'They have to message you first to reopen it.',
        );
      }
    } else {
      template = await this.prisma.whatsAppTemplate.findFirst({ where: { id: payload.templateId } });
      if (!template) throw new WhatsAppSendError(`template ${payload.templateId} not found`);
      if (template.status !== 'APPROVED') {
        throw new WhatsAppSendError(`template "${template.name}" is ${template.status}, not APPROVED by Meta — it cannot be sent`);
      }
      // §7: auto-pause BROADCASTS on a quality drop. Replies in a live session still go.
      if (template.category === 'MARKETING' && account?.broadcastsPausedByQuality) {
        throw new WhatsAppSendError(
          'marketing messages are paused: Meta flagged this number’s quality. Resume them from WhatsApp settings once you have checked why.',
        );
      }
    }

    // Our own ceiling under Meta's tiered limits. 0 = unlimited.
    const limit = settings?.whatsappDailyLimit ?? 250;
    if (limit > 0) {
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const sentToday = await this.prisma.interactionEvent.count({
        where: { channel: 'WHATSAPP', direction: 'OUTBOUND', status: 'SENT', createdAt: { gte: startOfDay } },
      });
      if (sentToday >= limit) throw new WhatsAppSendError(`the daily WhatsApp limit of ${limit} has been reached`);
    }

    // Re-derived from the dealer at send time, not trusted from the draft: a value changed
    // between drafting and sending must not go out stale. The logged body is what is
    // actually rendered from these, so "what exactly did we send" stays true (§4).
    const params = template ? paramsFor(template.paramKeys, await this.fieldsFor(dealer)) : [];
    const body = template ? renderTemplate(template.bodyText, params) : draft.draftText;

    try {
      const result =
        payload.kind === 'template'
          ? await this.whatsapp.sendTemplate({ to, templateName: template!.name, language: template!.language, params })
          : await this.whatsapp.sendFreeform({ to, text: body });

      const event = await this.prisma.interactionEvent.create({
        data: {
          dealerId: dealer.id,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          messageDraftId: draft.id,
          providerMessageId: result.providerMessageId,
          status: 'SENT',
          toAddress: to,
          body,
        } as Prisma.InteractionEventUncheckedCreateInput,
      });
      await this.prisma.messageDraft.update({
        where: { id: draft.id },
        data: {
          status: draft.autoSendRuleId ? 'AUTO_SENT' : 'EDITED_AND_SENT',
          sentAt: now,
          lastSendError: null,
          sendAttempts: { increment: 1 },
        },
      });
      return event;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      await this.prisma.interactionEvent.create({
        data: {
          dealerId: dealer.id,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          messageDraftId: draft.id,
          status: 'FAILED',
          toAddress: to,
          errorText,
          body,
        } as Prisma.InteractionEventUncheckedCreateInput,
      });
      // Stays APPROVED with the reason recorded — the same retry-queue shape as email.
      await this.prisma.messageDraft.update({
        where: { id: draft.id },
        data: { lastSendError: errorText, sendAttempts: { increment: 1 } },
      });
      throw err;
    }
  }

  /** The database values a template's {{n}} are fed from (§1.4 — never typed in). */
  async fieldsFor(dealer: { businessName: string; contactPersonName: string | null; city: string | null; state: string | null }) {
    const org = await this.prisma.organization.findFirst({ select: { name: true } });
    return {
      contactName: dealer.contactPersonName,
      businessName: dealer.businessName,
      ourBusinessName: org?.name ?? '',
      city: dealer.city,
      state: dealer.state,
    };
  }
}
