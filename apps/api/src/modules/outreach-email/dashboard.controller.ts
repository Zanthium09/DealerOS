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
import { SequenceService } from './sequence.service';
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
    @Body() body: { maxDealers?: number; segmentFilter?: OutreachSegmentFilter; forceReview?: boolean } = {},
  ) {
    const options: ColdOutreachOptions = {
      maxDealers: typeof body.maxDealers === 'number' && body.maxDealers > 0 ? body.maxDealers : undefined,
      segmentFilter: body.segmentFilter,
      forceReview: body.forceReview === true,
    };
    return this.outreach.runColdOutreach(session.organizationId, options);
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
    @Body() body: { draftText?: unknown },
  ) {
    if (typeof body?.draftText !== 'string') throw new BadRequestException('draftText is required');
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

  /** Send history for one dealer, newest first — "what exactly did we send them" (§4). */
  @Get('interactions')
  interactions(@Query('dealerId') dealerId?: string) {
    return this.prisma.interactionEvent.findMany({
      where: { channel: 'EMAIL', ...(dealerId ? { dealerId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
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
   * The "how many to send" quantity, per identity. NOT a bypass of §6's warmup ramp —
   * ThrottleService.effectiveDailyLimit still caps sends to the warmup value while an
   * identity is warming up, regardless of what this is set to; raising it only takes
   * effect once warmup (plus its grace window) has passed. That is the correct
   * behaviour: this field is the ceiling an org wants once trusted, not a way to skip
   * the reason the ramp exists.
   */
  @Patch('sending-identities/:id')
  updateIdentity(@Param('id') id: string, @Body() body: { currentDailyLimit?: unknown }) {
    if (typeof body?.currentDailyLimit !== 'number' || body.currentDailyLimit < 1) {
      throw new BadRequestException('currentDailyLimit must be a positive number');
    }
    return this.prisma.sendingIdentity.update({
      where: { id },
      data: { currentDailyLimit: Math.floor(body.currentDailyLimit) },
    });
  }

  private async decideAndSend(draftId: string, decide: () => Promise<{ id: string }>) {
    const draft = await decide();
    try {
      const event = await this.send.sendApprovedDraft(draft.id);
      await this.sequence.start(event.organizationId, event.dealerId, event.id);
      return { sent: true, interactionEventId: event.id };
    } catch (err) {
      // The decision already happened and is audited — a send failure (e.g. daily
      // cap, kill switch) does not get silently swallowed, but it also does not
      // undo the approval: the draft is APPROVED and will need a manual resend path
      // once one exists, same as any approved-but-unsent draft would.
      if (err instanceof ApprovalError) throw err;
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }
}
