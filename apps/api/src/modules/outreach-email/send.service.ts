import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InteractionEvent, Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { EMAIL_PROVIDER, EmailProvider } from '../../providers/email';
import { currentConsentState, isEligibleForEmail } from './consent';
import { buildMessageId } from './message-id';
import { unsubscribeHeaders, unsubscribeUrl } from './unsubscribe';
import { KILL_SWITCH, KillSwitch, SEND_THROTTLE, SendThrottle } from './ports';
import { assertSendAllowed } from '../../core/killswitch/staging-guard';

export const SOURCE_MODULE = 'outreach-email';

export class EmailSendError extends Error {}

export type EmailSendConfig = {
  unsubscribeSecret: string;
  publicBaseUrl: string;
};

export const EMAIL_SEND_CONFIG = 'OUTREACH_EMAIL_SEND_CONFIG';

/**
 * §5.2 / §6 — takes an APPROVED MessageDraft from this module and actually sends it.
 * Every guard here is a hard stop, not documentation: an unverified identity, an
 * INVALID or suppressed address, a paused channel or an exhausted daily cap refuse to
 * send rather than logging a warning and going ahead.
 */
@Injectable()
export class EmailSendService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(SEND_THROTTLE) private readonly throttle: SendThrottle,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitch,
    @Inject(EMAIL_SEND_CONFIG) private readonly config: EmailSendConfig,
  ) {}

  async sendApprovedDraft(draftId: string): Promise<InteractionEvent> {
    const draft = await this.prisma.messageDraft.findFirst({ where: { id: draftId } });
    if (!draft) throw new EmailSendError(`no draft ${draftId} in this organization`);
    if (draft.sourceModule !== SOURCE_MODULE) {
      throw new EmailSendError(`draft ${draftId} belongs to ${draft.sourceModule}, not ${SOURCE_MODULE}`);
    }
    if (draft.status !== 'APPROVED') {
      throw new EmailSendError(`draft ${draftId} is ${draft.status}, not APPROVED — it cannot be sent (§9)`);
    }

    if (await this.killSwitch.isPaused('EMAIL')) {
      throw new EmailSendError('EMAIL channel is paused by the kill switch (§12.6)');
    }

    const dealer = await this.prisma.dealer.findFirst({ where: { id: draft.dealerId } });
    if (!dealer) throw new EmailSendError(`dealer ${draft.dealerId} not found`);

    // Defence in depth: consent may have changed between drafting and sending.
    const consent = await currentConsentState(this.prisma, dealer.id, 'EMAIL');
    if (!isEligibleForEmail(consent)) {
      throw new EmailSendError(`dealer ${dealer.id} is EMAIL opted out — refusing to send (§10.2)`);
    }

    const dealerEmail =
      (await this.prisma.dealerEmail.findFirst({ where: { dealerId: dealer.id, isPrimary: true } })) ??
      (await this.prisma.dealerEmail.findFirst({ where: { dealerId: dealer.id } }));
    if (!dealerEmail) throw new EmailSendError(`dealer ${dealer.id} has no email address`);
    if (dealerEmail.verificationStatus === 'INVALID') {
      throw new EmailSendError(`dealer ${dealer.id}'s email is INVALID — never sent to (§6)`);
    }
    // Checked here, not only at import: a bad address reaching the provider comes
    // back as an opaque 4xx that used to surface as "Internal server error", and it
    // burns sender reputation. Imported data is messy — one real dealer's primary
    // address was the literal string "microdots", a fragment of a free-text cell.
    if (!isPlausibleEmail(dealerEmail.address)) {
      await this.prisma.dealerEmail.update({
        where: { id: dealerEmail.id },
        data: { verificationStatus: 'INVALID' },
      });
      throw new EmailSendError(
        `"${dealerEmail.address}" is not a valid email address — marked INVALID, not sent. ` +
          `Fix this dealer's address to reach them.`,
      );
    }

    // §12.7 — a code-level guard, not documentation. A no-op in production; everywhere
    // else it throws unless this address is a recognised test destination, regardless
    // of what credentials happen to be loaded. Was previously written but never called
    // from the real send path — the only real send path in the app.
    assertSendAllowed({ email: dealerEmail.address });

    const suppressed = await this.prisma.suppression.findFirst({ where: { email: dealerEmail.address } });
    if (suppressed) {
      throw new EmailSendError(`${dealerEmail.address} is on this organization's suppression list (§6)`);
    }

    // §6 — "never send from the organization's primary business domain". There is no
    // API in this module to name an arbitrary from-domain at all: the only address a
    // send can come from is a verified SendingIdentity row's own domain, which by
    // construction is a separate mail-* domain the org registered for exactly this
    // (§6's `mail-<orgslug>.in` example) — never the business's own domain, because
    // nothing here ever reads or sends from one. See the wiring note in the module's
    // index.ts / report for the one thing this does NOT check: nothing stops an
    // operator from registering a SendingIdentity whose domain happens to equal the
    // org's real domain — Organization has no "primary domain" column to compare
    // against, so that specific misconfiguration is out of scope here.
    const identity = await this.prisma.sendingIdentity.findFirst({
      where: { verificationStatus: 'VERIFIED' },
      orderBy: { createdAt: 'asc' },
    });
    if (!identity) {
      throw new EmailSendError('no verified SendingIdentity for this organization — SPF/DKIM/DMARC required (§6)');
    }

    // The daily ceiling lives entirely in the throttle now (throttle.impl.ts), which
    // reads the org's OutreachSettings. It used to be duplicated here as an
    // unconditional count against `identity.currentDailyLimit` — a second, hidden cap
    // that no setting could raise, so "throttle disabled" could not actually mean
    // disabled while it stood.
    const decision = await this.throttle.tryConsume(dealer.organizationId);
    if (!decision.allowed) {
      throw new EmailSendError(`send throttled: ${decision.reason ?? 'no budget right now'}`);
    }

    const interactionEventId = randomUUID();
    const unsubUrl = unsubscribeUrl(this.config.publicBaseUrl, this.config.unsubscribeSecret, dealer.organizationId, dealer.id);
    const headers = {
      'Message-ID': buildMessageId(dealer.organizationId, interactionEventId, identity.domain),
      ...unsubscribeHeaders(unsubUrl),
    };
    const tags = {
      organizationId: dealer.organizationId,
      dealerId: dealer.id,
      interactionEventId,
      messageDraftId: draft.id,
    };

    // Every email used to carry the identical hardcoded subject "A note about your
    // business". Thousands of cold sends sharing one subject line is among the
    // strongest spam signals a new domain can emit, and it was not editable anywhere.
    const subject = draft.subject?.trim() || DEFAULT_SUBJECT;
    const fromAddress = `${identity.fromLocalPart || 'sales'}@${identity.domain}`;
    const from = identity.fromName ? `${quoteDisplayName(identity.fromName)} <${fromAddress}>` : fromAddress;

    let providerMessageId: string;
    try {
      const result = await this.email.send({
        from,
        to: dealerEmail.address,
        cc: draft.ccEmails.filter(isPlausibleEmail),
        bcc: draft.bccEmails.filter(isPlausibleEmail),
        replyTo: identity.replyToAddress ?? undefined,
        subject,
        text: draft.draftText,
        html: draft.bodyHtml ?? undefined,
        headers,
        tags,
      });
      providerMessageId = result.providerMessageId;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      await this.prisma.interactionEvent.create({
        data: {
          id: interactionEventId,
          dealerId: dealer.id,
          channel: 'EMAIL',
          direction: 'OUTBOUND',
          messageDraftId: draft.id,
          status: 'FAILED',
          subject,
          toAddress: dealerEmail.address,
          errorText,
          body: draft.draftText,
        } as Prisma.InteractionEventUncheckedCreateInput,
      });
      // Leaves the draft APPROVED but now marked with why it failed, which is what
      // makes it show up in the retry queue instead of vanishing (§9 forbids
      // re-deciding it, so retry re-sends rather than re-approves).
      await this.prisma.messageDraft.update({
        where: { id: draft.id },
        data: { lastSendError: errorText, sendAttempts: { increment: 1 } },
      });
      throw err;
    }

    const event = await this.prisma.interactionEvent.create({
      data: {
        id: interactionEventId,
        dealerId: dealer.id,
        channel: 'EMAIL',
        direction: 'OUTBOUND',
        messageDraftId: draft.id,
        providerMessageId,
        status: 'SENT',
        subject,
        toAddress: dealerEmail.address,
        body: draft.draftText,
      } as Prisma.InteractionEventUncheckedCreateInput,
    });

    await this.prisma.messageDraft.update({
      where: { id: draft.id },
      // §9 — the queue never writes AUTO_SENT/EDITED_AND_SENT: nothing may claim a
      // message was sent before one was. This is the moment one actually was.
      // ponytail: AUTO_SENT vs EDITED_AND_SENT is decided from autoSendRuleId, the
      // one field that reliably tells auto-approval apart from a human decision —
      // MessageDraft does not separately record "was the text edited", so a
      // human-approved-unedited send is also stamped EDITED_AND_SENT, the closer of
      // the two available terminal values (a human, not a rule, decided it).
      data: {
        status: draft.autoSendRuleId ? 'AUTO_SENT' : 'EDITED_AND_SENT',
        sentAt: new Date(),
        lastSendError: null,
        sendAttempts: { increment: 1 },
      },
    });

    return event;
  }

  /**
   * Re-attempt a draft whose send failed. §9's approval guard rejects deciding a
   * draft twice, and rightly so — but that also meant a send that failed for a
   * transient reason (provider 429, a paused channel, a since-corrected address)
   * could never be retried at all, because the draft was already APPROVED. Retry
   * skips the decision entirely and repeats only the dispatch.
   */
  async retryFailedDraft(draftId: string): Promise<InteractionEvent> {
    const draft = await this.prisma.messageDraft.findFirst({ where: { id: draftId } });
    if (!draft) throw new EmailSendError(`no draft ${draftId} in this organization`);
    if (draft.status !== 'APPROVED') {
      throw new EmailSendError(
        `draft ${draftId} is ${draft.status} — only an APPROVED draft whose send failed can be retried`,
      );
    }
    return this.sendApprovedDraft(draftId);
  }
}

/** Used when a draft carries no subject of its own (older rows, and the seeded
 *  default template before an org writes its own). */
export const DEFAULT_SUBJECT = 'Dealer partnership enquiry';

/**
 * Deliberately permissive: one @, a dot-bearing domain, no spaces. Not RFC 5322 —
 * that grammar accepts things no real mail server does and rejecting a deliverable
 * address is worse than passing a doubtful one to the provider. This exists to
 * catch the genuinely-not-an-address values that messy imports produce.
 */
export function isPlausibleEmail(address: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/.test(address.trim());
}

/** RFC 5322 display names need quoting once they contain a comma, dot or quote. */
function quoteDisplayName(name: string): string {
  return `"${name.replace(/["\\]/g, '')}"`;
}
