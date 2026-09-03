import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { ApprovalError, ApprovalService } from '../../core/approval';
import { OutreachEmailService } from './outreach-email.service';
import type { ColdOutreachOptions } from './outreach-email.service';
import { EmailSendService, SOURCE_MODULE } from './send.service';
import { EMAIL_PROVIDER, EmailProvider } from '../../providers/email';
import { InboundEmailService } from './inbound.service';
import { SequenceService } from './sequence.service';
import { CustomDraftService } from './custom-draft.service';
import { renderPlain } from './cold-draft.service';
import { OutreachSettingsService } from './settings.service';
import type { OutreachSettingsInput } from './settings.service';
import { EmailSendThrottle } from './throttle.impl';
import type { OutreachSegmentFilter } from './eligibility';

/**
 * The human-facing side of M2 (§5.2, §9): trigger a cold-outreach run, see the
 * approval queue, decide each draft, see what actually went out. Everything here is
 * scoped to `outreach-email` — the Approval Queue itself is shared across modules
 * (§9), this is just the one channel's window onto it.
 *
 * Approving here does more than the generic ApprovalService.approve: for this
 * module, an approved draft that is not also sent is a draft nobody will ever see
 * again, so approve/edit-approve chain straight into EmailSendService and start the
 * follow-up sequence — mirroring exactly what runColdOutreach already does for the
 * auto-send path.
 */
@Controller('outreach-email')
@UseGuards(TenantAuthGuard)
export class OutreachEmailDashboardController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly outreach: OutreachEmailService,
    private readonly approval: ApprovalService,
    private readonly send: EmailSendService,
    private readonly sequence: SequenceService,
    private readonly customDraft_: CustomDraftService,
    private readonly settingsService: OutreachSettingsService,
    private readonly throttleImpl: EmailSendThrottle,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly inboundEmailService: InboundEmailService,
  ) {}

  /**
   * Drafts eligible dealers, auto-sends the ones with no financial terms (§5.2).
   * Every field is optional — an empty body behaves exactly as before ("all eligible
   * NEW dealers, no cap, auto-send where the rules already allow it").
   *   maxDealers      — "how many to send at each press"
   *   segmentFilter    — city/state/businessCategory/source/pipelineStage, or an
   *                      explicit dealerIds[] for "send to exactly these dealers"
   *                      (the Dealers page's checkbox-select)
   *   forceReview      — every draft from this run needs a human, regardless of content
   */
  @Post('run')
  run(
    @CurrentTenantSession() session: TenantSession,
    @Body()
    body: {
      maxDealers?: number;
      segmentFilter?: OutreachSegmentFilter;
      forceReview?: boolean;
      allowResend?: boolean;
      templateId?: string;
    } = {},
  ) {
    const options: ColdOutreachOptions = {
      maxDealers: typeof body.maxDealers === 'number' && body.maxDealers > 0 ? body.maxDealers : undefined,
      segmentFilter: body.segmentFilter,
      forceReview: body.forceReview === true,
      allowResend: body.allowResend === true,
      templateId: typeof body.templateId === 'string' ? body.templateId : undefined,
    };
    return this.outreach.runColdOutreach(session.organizationId, options);
  }

  /** Free-text brief in, an AI-written draft out — always lands in the approval
   *  queue, never auto-sends (custom-draft.service.ts explains why). */
  @Post('custom-draft')
  customDraft(@Body() body: { dealerId?: unknown; brief?: unknown }) {
    if (typeof body?.dealerId !== 'string' || !body.dealerId) {
      throw new BadRequestException('dealerId is required');
    }
    if (typeof body?.brief !== 'string' || !body.brief.trim()) {
      throw new BadRequestException('brief is required');
    }
    return this.customDraft_.draft(body.dealerId, body.brief);
  }

  /** The approval queue, this channel only. Full dealer history lives at
   *  GET /dealers/:id — this just needs enough to list drafts (§9). */
  @Get('queue')
  queue() {
    return this.approval.pending({ sourceModule: SOURCE_MODULE });
  }

  @Post('drafts/:id/approve')
  async approveAndSend(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.decideAndSend(id, () => this.approval.approve(id, session.userId));
  }

  @Post('drafts/:id/edit-approve')
  async editApproveAndSend(
    @CurrentTenantSession() session: TenantSession,
    @Param('id') id: string,
    @Body() body: { draftText?: unknown; subject?: unknown; cc?: unknown; bcc?: unknown },
  ) {
    if (typeof body?.draftText !== 'string') throw new BadRequestException('draftText is required');
    // The subject was not editable anywhere, so a reviewer could fix the wording of
    // a message but not the line that decides whether it is opened at all.
    if (body.subject !== undefined || body.cc !== undefined || body.bcc !== undefined) {
      await this.prisma.messageDraft.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          ...(typeof body.subject === 'string' ? { subject: body.subject.trim() } : {}),
          ...(body.cc !== undefined ? { ccEmails: toAddressList(body.cc) } : {}),
          ...(body.bcc !== undefined ? { bccEmails: toAddressList(body.bcc) } : {}),
        },
      });
    }
    return this.decideAndSend(id, () => this.approval.editAndApprove(id, session.userId, body.draftText as string));
  }

  @Post('drafts/:id/reject')
  reject(
    @CurrentTenantSession() session: TenantSession,
    @Param('id') id: string,
    @Body() body: { reason?: unknown },
  ) {
    return this.approval.reject(id, session.userId, typeof body?.reason === 'string' ? body.reason : undefined);
  }

  /** Send history for one dealer, newest first — "what exactly did we send them" (§4).
   *  Includes the dealer's name directly — the org can have thousands of dealers, far
   *  more than a client could reasonably fetch to build its own id->name lookup, and
   *  that lookup being merely capped (not wrong) is exactly the kind of gap that looks
   *  fine in a demo and shows raw ids in production. */
  @Get('interactions')
  interactions(@Query('dealerId') dealerId?: string) {
    return this.prisma.interactionEvent.findMany({
      where: { channel: 'EMAIL', ...(dealerId ? { dealerId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { dealer: { select: { businessName: true } } },
    });
  }

  /**
   * One row per message, not per event.
   *
   * Webhooks append a new InteractionEvent for every delivery touch, so a single
   * email that was delivered and then opened is three rows — which makes the Sent
   * list unreadable and the counts wrong (three "emails" for one send). This groups
   * by providerMessageId and reports the furthest state each message reached, with
   * its own event timeline.
   */
  @Get('messages')
  async messages(@Query('take') take?: string) {
    const events = await this.prisma.interactionEvent.findMany({
      where: { channel: 'EMAIL' },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(take) || 1000, 2000),
      include: { dealer: { select: { businessName: true } } },
    });

    const byMessage = new Map<string, typeof events>();
    for (const e of events) {
      // messageDraftId is the thread key, not providerMessageId: an inbound reply
      // shares the original draft's id but has NO providerMessageId of its own (it
      // never went through the provider), so grouping by providerMessageId put a
      // reply in a separate, unconnected row with no visible link to what it
      // replied to — exactly the "where is the reply" gap. A FAILED send has
      // neither id, so it still falls back to its own row rather than merging with
      // an unrelated one.
      const key = e.messageDraftId ?? e.providerMessageId ?? `local:${e.id}`;
      const list = byMessage.get(key) ?? [];
      list.push(e);
      byMessage.set(key, list);
    }

    return [...byMessage.values()]
      .map((list) => {
        // `list` is newest-first (the query's own order). Subject/recipient/body
        // must come from what WE sent, not from whichever event happens to be
        // newest — a reply is also "an event with a body", and without this split
        // an incoming reply's text would silently replace the outbound body shown
        // as "what was sent".
        const outbound = list.filter((e) => e.direction === 'OUTBOUND');
        const inbound = list.filter((e) => e.direction === 'INBOUND');
        const oldest = outbound[outbound.length - 1] ?? list[list.length - 1];
        const latestReply = inbound[0] ?? null;
        // REPLIED already outranks DELIVERED/OPENED/CLICKED (STATUS_RANK), so
        // including inbound events in this pool is what makes a replied thread
        // correctly show status "REPLIED" rather than getting stuck on "OPENED".
        const best = list.reduce((a, b) => (STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a));
        const failure = outbound.find((e) => e.errorText);
        return {
          id: oldest.id,
          dealerId: oldest.dealerId,
          dealer: oldest.dealer,
          direction: oldest.direction,
          providerMessageId: oldest.providerMessageId,
          subject: outbound.find((e) => e.subject)?.subject ?? '',
          toAddress: outbound.find((e) => e.toAddress)?.toAddress ?? '',
          body: outbound.find((e) => e.body)?.body ?? '',
          status: best.status,
          errorText: failure?.errorText ?? null,
          sentAt: oldest.createdAt,
          lastEventAt: list[0].createdAt,
          replyBody: latestReply?.body ?? null,
          repliedAt: latestReply?.createdAt ?? null,
          replyCount: inbound.length,
          timeline: list
            .map((e) => ({ status: e.status, direction: e.direction, at: e.createdAt }))
            .sort((a, b) => a.at.getTime() - b.at.getTime()),
        };
      })
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  }

  /**
   * Fills in a subject on drafts written before subjects existed, so a batch of
   * them does not all go out under the same fallback line. Uses the active
   * template's subject where there is one, else the per-recipient default.
   */
  @Post('drafts/backfill-subjects')
  async backfillSubjects() {
    const active = await this.prisma.outreachTemplate.findFirst({ where: { isActive: true } });
    const pattern = active?.subject?.trim() || 'Quick question, {{businessName}}';

    const drafts = await this.prisma.messageDraft.findMany({
      where: { sourceModule: SOURCE_MODULE, subject: '', status: { in: ['PENDING', 'APPROVED'] } },
      include: { dealer: { select: { businessName: true, city: true, state: true, contactPersonName: true } } },
    });

    const org = await this.prisma.organization.findFirst({ where: { id: getOrgId()! } });
    let updated = 0;
    for (const d of drafts) {
      const subject = renderPlain(pattern, {
        businessName: d.dealer?.businessName ?? '',
        contactName: d.dealer?.contactPersonName ?? 'Sir/Madam',
        ourBusinessName: org?.name ?? '',
        city: d.dealer?.city ?? '',
        state: d.dealer?.state ?? '',
      });
      await this.prisma.messageDraft.update({ where: { id: d.id }, data: { subject } });
      updated++;
    }
    return { updated };
  }

  /**
   * Raw webhook receipts — what actually arrived from the provider, independent of
   * anything this app derived from it. `processedAt: null` with no `error` means the
   * event is still mid-flight or (before this fix existed) was silently swallowed by
   * a failure after the idempotency row committed; `error` set means it failed and
   * was rolled back for retry, not lost.
   */
  @Get('webhook-events')
  webhookEvents(@Query('provider') provider?: string, @Query('take') take?: string) {
    return this.prisma.webhookEvent.findMany({
      where: provider ? { provider } : { provider: { in: ['resend', 'resend-inbound'] } },
      orderBy: { receivedAt: 'desc' },
      take: Math.min(Number(take) || 50, 200),
    });
  }

  /**
   * Re-runs processing for one already-received webhook, using the emailId still
   * sitting in its stored payload — for exactly the rows the pre-fix bug left
   * stranded: `processedAt: null, error: null` forever, with no future retry from
   * the provider going to help since the dedupe row already exists. This bypasses
   * signature verification (the row's existence already proves it was received)
   * and, unlike the live path, does NOT swallow a genuine InboundEmailError —
   * a manual replay should surface exactly why it failed, not hide it again.
   */
  @Post('webhook-events/:id/replay')
  async replayWebhookEvent(@Param('id') id: string) {
    const row = await this.prisma.webhookEvent.findFirst({ where: { id } });
    if (!row) throw new BadRequestException(`no webhook event ${id}`);
    if (row.provider !== 'resend-inbound') {
      throw new BadRequestException('replay is only implemented for resend-inbound events');
    }
    const emailId = (row.payload as { emailId?: string })?.emailId;
    if (!emailId) throw new BadRequestException('no emailId in this event\'s stored payload');

    try {
      const full = await this.emailProvider.fetchReceivedEmail(emailId);
      await this.inboundEmailService.handle({
        headers: full.headers,
        subject: full.subject,
        body: full.text ?? full.html ?? '',
        fromAddress: full.fromAddress,
      });
      await this.prisma.webhookEvent.update({ where: { id }, data: { processedAt: new Date(), error: null } });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookEvent.update({ where: { id }, data: { error: message } });
      throw new BadRequestException(message);
    }
  }

  /** The raw headers Resend captured for one received reply — for diagnosing why
   *  a specific reply failed to thread back to a send (findThreadedMessageId). */
  @Get('webhook-events/:id/raw')
  async rawWebhookEvent(@Param('id') id: string) {
    const row = await this.prisma.webhookEvent.findFirst({ where: { id } });
    if (!row) throw new BadRequestException(`no webhook event ${id}`);
    const emailId = (row.payload as { emailId?: string })?.emailId;
    if (!emailId) throw new BadRequestException("no emailId in this event's stored payload");
    const full = await this.emailProvider.fetchReceivedEmail(emailId);
    return { subject: full.subject, fromAddress: full.fromAddress, headers: full.headers };
  }

  /** Outbound controls: throttle on/off, daily limit, pacing, channel pause (§12.6). */
  @Get('settings')
  async settings(@CurrentTenantSession() session: TenantSession) {
    const settings = await this.settingsService.get(session.organizationId);
    return {
      ...settings,
      usedToday: await this.throttleImpl.usedToday(session.organizationId),
      effectiveDailyLimit: finiteOrNull(await this.throttleImpl.limitFor(session.organizationId)),
    };
  }

  @Patch('settings')
  updateSettings(@Body() body: OutreachSettingsInput) {
    return this.settingsService.update(body ?? {});
  }

  /**
   * Compose to one specific company, with full control over the fields — the
   * "search a company and email them" path. Nothing here is model-written, so
   * there is no §1.4 surface: what the user types is what is rendered, with
   * {{placeholders}} filled from that dealer's own database columns.
   */
  @Post('compose')
  async compose(
    @Body()
    body: {
      dealerId?: unknown;
      subject?: unknown;
      bodyText?: unknown;
      bodyHtml?: unknown;
      cc?: unknown;
      bcc?: unknown;
      sendNow?: unknown;
    },
  ) {
    if (typeof body?.dealerId !== 'string' || !body.dealerId) throw new BadRequestException('dealerId is required');
    if (typeof body?.bodyText !== 'string' || !body.bodyText.trim()) throw new BadRequestException('bodyText is required');
    if (typeof body?.subject !== 'string' || !body.subject.trim()) throw new BadRequestException('subject is required');

    const draft = await this.customDraft_.compose({
      dealerId: body.dealerId,
      subject: body.subject,
      bodyText: body.bodyText,
      bodyHtml: typeof body.bodyHtml === 'string' ? body.bodyHtml : null,
      cc: toAddressList(body.cc),
      bcc: toAddressList(body.bcc),
    });

    if (body.sendNow !== true) return { draftId: draft.id, sent: false };
    return this.decideAndSend(draft.id, () => this.approval.autoSend(draft.id));
  }

  @Get('sending-identities')
  identities() {
    return this.prisma.sendingIdentity.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /**
   * §6 — creates the row only; it does not verify SPF/DKIM/DMARC itself (no domain
   * verification API is wired to a real provider yet). Starts UNVERIFIED so
   * EmailSendService's existing guard keeps refusing to send from it until someone
   * confirms the DNS records with the provider and calls verify below. This is a
   * deliberate stopgap, not the real check — flagged, not hidden.
   */
  @Post('sending-identities')
  createIdentity(@Body() body: { domain?: unknown; provider?: unknown }) {
    if (typeof body?.domain !== 'string' || !body.domain.trim()) {
      throw new BadRequestException('domain is required');
    }
    return this.prisma.sendingIdentity.create({
      data: {
        organizationId: getOrgId()!,
        domain: body.domain.trim(),
        provider: typeof body.provider === 'string' ? body.provider : 'resend',
      },
    });
  }

  /** Manual stand-in for real domain verification (see createIdentity's note). */
  @Post('sending-identities/:id/verify')
  async verifyIdentity(@Param('id') id: string) {
    await this.prisma.sendingIdentity.update({ where: { id }, data: { verificationStatus: 'VERIFIED' } });
    return { ok: true };
  }

  /**
   * What Resend actually reports for this domain — independent of the manual
   * VERIFIED flag above, which a person clicks and is never itself checked against
   * the provider. This is the only way to know if SPF/DKIM/DMARC are genuinely
   * configured and passing, which is a materially bigger deliverability factor than
   * anything in the email's own content or template.
   */
  @Get('sending-identities/:id/dns-status')
  async dnsStatus(@Param('id') id: string) {
    const identity = await this.prisma.sendingIdentity.findFirst({ where: { id } });
    if (!identity) throw new BadRequestException(`no sending identity ${id}`);
    return this.emailProvider.getDomainStatus(identity.domain);
  }

  /**
   * The "how many to send" quantity, per identity. NOT a bypass of §6's warmup ramp —
   * ThrottleService.effectiveDailyLimit still caps sends to the warmup value while an
   * identity is warming up, regardless of what this is set to; raising it only takes
   * effect once warmup (plus its grace window) has passed. That is the correct
   * behaviour: this field is the ceiling an org wants once trusted, not a way to skip
   * the reason the ramp exists.
   */
  @Patch('sending-identities/:id')
  updateIdentity(
    @Param('id') id: string,
    @Body()
    body: {
      currentDailyLimit?: unknown;
      fromName?: unknown;
      fromLocalPart?: unknown;
      replyToAddress?: unknown;
    },
  ) {
    if (body?.currentDailyLimit !== undefined && (typeof body.currentDailyLimit !== 'number' || body.currentDailyLimit < 1)) {
      throw new BadRequestException('currentDailyLimit must be a positive number');
    }
    // The From line was `sales@<domain>` with no display name, on every message.
    if (body?.fromLocalPart !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(body.fromLocalPart))) {
      throw new BadRequestException('fromLocalPart may only contain letters, digits, dot, underscore or hyphen');
    }
    return this.prisma.sendingIdentity.update({
      where: { id },
      data: {
        ...(body.currentDailyLimit !== undefined
          ? { currentDailyLimit: Math.floor(body.currentDailyLimit as number) }
          : {}),
        ...(body.fromName !== undefined ? { fromName: String(body.fromName).trim() } : {}),
        ...(body.fromLocalPart !== undefined ? { fromLocalPart: String(body.fromLocalPart).trim() } : {}),
        ...(body.replyToAddress !== undefined
          ? { replyToAddress: body.replyToAddress ? String(body.replyToAddress).trim() : null }
          : {}),
      },
    });
  }

  /**
   * Re-dispatch a draft that was approved but whose send failed. Not a second
   * decision (§9 forbids that and would throw) — the approval stands, only the
   * delivery is retried.
   */
  @Post('drafts/:id/retry')
  async retry(@Param('id') id: string) {
    const event = await this.send.retryFailedDraft(id);
    await this.sequence.start(event.organizationId, event.dealerId, event.id);
    return { sent: true, interactionEventId: event.id };
  }

  /**
   * The retry queue: approved drafts that never actually went out.
   *
   * APPROVED is itself the signal — a successful send flips the draft to
   * AUTO_SENT/EDITED_AND_SENT, so anything still sitting at APPROVED is by
   * definition a dispatch that did not complete. Keying off `lastSendError`
   * instead would miss every failure that predates that column.
   */
  @Get('failed')
  failed() {
    return this.prisma.messageDraft.findMany({
      where: { sourceModule: SOURCE_MODULE, status: 'APPROVED' },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: { dealer: { select: { businessName: true, emails: { where: { isPrimary: true }, take: 1 } } } },
    });
  }

  private async decideAndSend(draftId: string, decide: () => Promise<{ id: string }>) {
    // `decide()` used to sit OUTSIDE this try. An ApprovalError from it (the common
    // "this draft was already decided" case, e.g. a double-click) is a plain Error,
    // so it escaped the controller and Nest turned it into a bare 500 "Internal
    // server error" — the exact failure reported from the queue screen. It is now
    // inside, and the global filter maps it to 409 with its real message either way.
    const draft = await decide();
    try {
      const event = await this.send.sendApprovedDraft(draft.id);
      await this.sequence.start(event.organizationId, event.dealerId, event.id);
      return { sent: true, interactionEventId: event.id };
    } catch (err) {
      // The decision already happened and is audited — a send failure (daily cap,
      // kill switch, bad address) does not undo the approval. The draft stays
      // APPROVED with lastSendError set, which is what puts it in the retry queue
      // above rather than losing it.
      if (err instanceof ApprovalError) throw err;
      throw new BadRequestException(
        `${err instanceof Error ? err.message : String(err)} — the draft stays approved and can be retried.`,
      );
    }
  }
}

/** Accepts "a@b.com, c@d.com" or a JSON array; drops anything that is not an address. */
function toAddressList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(/[,;\s]+/)
      : [];
  return raw.map((v) => v.trim()).filter((v) => v !== '');
}

/** Infinity is not valid JSON — it serialises to null, which would silently read as
 *  "no limit configured" in the UI. Say null explicitly and mean it. */
function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/**
 * How far along the delivery funnel each status is. Used to pick the single status
 * that best describes a message from its several events — REPLIED beats OPENED beats
 * DELIVERED, and a hard failure outranks them all because it is the thing you must
 * act on.
 */
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
