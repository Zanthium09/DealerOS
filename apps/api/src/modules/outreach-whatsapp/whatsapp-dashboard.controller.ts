import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { ApprovalError, ApprovalService } from '../../core/approval';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { RATE_INR, RATES_AS_OF, sessionOpen } from './rules';
import { SOURCE_MODULE, WhatsAppSendService } from './whatsapp-send.service';
import { WhatsAppDraftService } from './whatsapp-draft.service';
import { TemplateInput, WhatsAppTemplateService } from './template.service';

/**
 * The human-facing side of M3: link the number, manage templates, run a warm campaign
 * through the Approval Queue, and answer the dealers the state machine hands to a person.
 */
@Controller('outreach-whatsapp')
@UseGuards(TenantAuthGuard)
export class WhatsAppDashboardController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly templates: WhatsAppTemplateService,
    private readonly drafts: WhatsAppDraftService,
    private readonly sender: WhatsAppSendService,
    private readonly approval: ApprovalService,
  ) {}

  // ---- account & settings -------------------------------------------------------

  @Get('settings')
  async settings() {
    const [s, account] = await Promise.all([this.prisma.outreachSettings.findFirst(), this.prisma.whatsAppAccount.findFirst()]);
    return {
      paused: s?.whatsappPaused ?? false,
      dailyLimit: s?.whatsappDailyLimit ?? 250,
      account,
      configured: !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      rates: { ...RATE_INR, asOf: RATES_AS_OF },
    };
  }

  @Patch('settings')
  async updateSettings(@Body() body: { paused?: unknown; dailyLimit?: unknown }) {
    const data: { whatsappPaused?: boolean; whatsappDailyLimit?: number } = {};
    if (typeof body?.paused === 'boolean') data.whatsappPaused = body.paused;
    if (typeof body?.dailyLimit === 'number') data.whatsappDailyLimit = Math.max(0, Math.floor(body.dailyLimit));
    const orgId = getOrgId()!;
    await this.prisma.outreachSettings.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, ...data },
      update: data,
    });
    return this.settings();
  }

  /** Links this organization to its WhatsApp Business number — what inbound webhooks are
   *  routed by. The access token stays in the environment for now (§7: per-customer
   *  credentials arrive with Embedded Signup). */
  @Post('account')
  async linkAccount(@Body() body: { phoneNumberId?: string; wabaId?: string; displayPhone?: string }) {
    if (!body?.phoneNumberId?.trim() || !body.wabaId?.trim()) throw new BadRequestException('phoneNumberId and wabaId are required');
    const orgId = getOrgId()!;
    try {
      return await this.prisma.whatsAppAccount.upsert({
        where: { organizationId: orgId },
        create: { organizationId: orgId, phoneNumberId: body.phoneNumberId.trim(), wabaId: body.wabaId.trim(), displayPhone: body.displayPhone ?? null },
        update: { phoneNumberId: body.phoneNumberId.trim(), wabaId: body.wabaId.trim(), displayPhone: body.displayPhone ?? null },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new BadRequestException('that number or WhatsApp Business Account is already linked to another organization');
      throw err;
    }
  }

  /** A person, having looked at why Meta flagged the number, turns marketing back on. */
  @Post('resume-broadcasts')
  async resumeBroadcasts() {
    await this.prisma.whatsAppAccount.updateMany({ data: { broadcastsPausedByQuality: false } });
    return { ok: true };
  }

  // ---- templates ----------------------------------------------------------------

  @Get('templates')
  listTemplates() {
    return this.templates.list();
  }

  @Post('templates')
  createTemplate(@Body() body: TemplateInput) {
    return this.templates.create(body);
  }

  @Post('templates/:id/submit')
  submitTemplate(@Param('id') id: string) {
    return this.templates.submit(id);
  }

  @Post('templates/:id/sync')
  syncTemplate(@Param('id') id: string) {
    return this.templates.sync(id);
  }

  @Delete('templates/:id')
  async removeTemplate(@Param('id') id: string) {
    await this.templates.remove(id);
    return { ok: true };
  }

  // ---- campaigns → Approval Queue ------------------------------------------------

  @Get('campaign/estimate')
  estimate(@Query('templateId') templateId: string, @Query('maxDealers') maxDealers?: string) {
    if (!templateId) throw new BadRequestException('templateId is required');
    return this.drafts.estimate(templateId, Number(maxDealers) || undefined);
  }

  @Post('campaign')
  campaign(@Body() body: { templateId?: string; maxDealers?: number; dealerIds?: string[] }) {
    if (!body?.templateId) throw new BadRequestException('templateId is required');
    return this.drafts.campaign({ templateId: body.templateId, maxDealers: body.maxDealers, dealerIds: body.dealerIds });
  }

  @Post('dealers/:dealerId/template')
  draftTemplate(@Param('dealerId') dealerId: string, @Body() body: { templateId?: string }) {
    if (!body?.templateId) throw new BadRequestException('templateId is required');
    return this.drafts.draftTemplateFor(dealerId, body.templateId);
  }

  @Get('queue')
  queue() {
    return this.approval.pending({ sourceModule: SOURCE_MODULE });
  }

  @Post('drafts/:id/approve')
  approve(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.decideAndSend(id, () => this.approval.approve(id, session.userId));
  }

  @Post('drafts/:id/reject')
  reject(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.approval.reject(id, session.userId);
  }

  /** Approved but never sent — the retry queue, same rule as email. */
  @Get('failed')
  failed() {
    return this.prisma.messageDraft.findMany({
      where: { sourceModule: SOURCE_MODULE, status: 'APPROVED' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: { dealer: { select: { businessName: true } } },
    });
  }

  @Post('drafts/:id/retry')
  async retry(@Param('id') id: string) {
    const event = await this.sender.sendApprovedDraft(id);
    return { sent: true, interactionEventId: event.id };
  }

  // ---- the human inbox ----------------------------------------------------------

  @Get('conversations')
  async conversations(@Query('needsHuman') needsHuman?: string) {
    const rows = await this.prisma.whatsAppConversation.findMany({
      where: needsHuman === 'true' ? { needsHuman: true } : {},
      orderBy: { lastInboundAt: 'desc' },
      take: 200,
      include: { dealer: { select: { businessName: true, city: true, pipelineStage: true } } },
    });
    const last = await Promise.all(
      rows.map((r) =>
        this.prisma.interactionEvent.findFirst({ where: { dealerId: r.dealerId, channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { body: true, direction: true } }),
      ),
    );
    return rows.map((r, i) => ({ ...r, sessionOpen: sessionOpen(r.sessionExpiresAt), lastMessage: last[i] }));
  }

  @Get('conversations/:dealerId/messages')
  messages(@Param('dealerId') dealerId: string) {
    return this.prisma.interactionEvent.findMany({
      where: { dealerId, channel: 'WHATSAPP', NOT: { body: '' } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  /** A person answers inside the open window. They are the approver (§9), so this is an
   *  approve-then-send of a human-composed draft — not an auto-send. */
  @Post('conversations/:dealerId/reply')
  async reply(@CurrentTenantSession() session: TenantSession, @Param('dealerId') dealerId: string, @Body() body: { text?: string }) {
    const draft = await this.drafts.draftReply(dealerId, body?.text ?? '');
    const res = await this.decideAndSend(draft.id, () => this.approval.approve(draft.id, session.userId));
    await this.prisma.whatsAppConversation.updateMany({ where: { dealerId }, data: { needsHuman: false, humanReason: null } });
    return res;
  }

  @Post('conversations/:dealerId/resolve')
  async resolve(@Param('dealerId') dealerId: string) {
    await this.prisma.whatsAppConversation.updateMany({ where: { dealerId }, data: { needsHuman: false, humanReason: null } });
    return { ok: true };
  }

  private async decideAndSend(draftId: string, decide: () => Promise<{ id: string }>) {
    const draft = await decide();
    try {
      const event = await this.sender.sendApprovedDraft(draft.id);
      return { sent: true, interactionEventId: event.id };
    } catch (err) {
      if (err instanceof ApprovalError) throw err;
      // The approval stands and is audited; the draft stays APPROVED with the reason
      // recorded, which is what puts it in the retry queue.
      throw new BadRequestException(`${err instanceof Error ? err.message : String(err)} — the draft stays approved and can be retried.`);
    }
  }
}
