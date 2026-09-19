import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { MessageDraft, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { eligibleWarmDealers, pickWhatsAppNumber, warmSignalsFor } from './eligibility';
import { estimateCost, isWarm, paramsFor, renderTemplate, sessionOpen } from './rules';
import { SOURCE_MODULE, WhatsAppDraftPayload, WhatsAppSendService } from './whatsapp-send.service';
import { WhatsAppTemplateService } from './template.service';

/**
 * Turns intent into MessageDrafts (§1.5) — every WhatsApp message passes through the
 * shared Approval Queue tables before it can become a send. WhatsApp text is never
 * model-written: a template's wording is fixed and approved by Meta, and only database
 * values are substituted (§1.4).
 */
@Injectable()
export class WhatsAppDraftService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly templates: WhatsAppTemplateService,
    private readonly sender: WhatsAppSendService,
  ) {}

  private async alreadyDraftedFor(templateId: string): Promise<Set<string>> {
    const rows = await this.prisma.messageDraft.findMany({
      where: { sourceModule: SOURCE_MODULE, templateVariables: { path: ['templateId'], equals: templateId } },
      select: { dealerId: true },
    });
    return new Set(rows.map((r) => r.dealerId));
  }

  /** Who a campaign would reach and what it would cost — shown BEFORE anything is drafted
   *  (§7: "show it before send confirmation"). */
  async estimate(templateId: string, maxDealers?: number) {
    const template = await this.templates.load(templateId);
    const done = await this.alreadyDraftedFor(templateId);
    const eligible = (await eligibleWarmDealers(this.prisma)).filter((d) => !done.has(d.id));
    const count = maxDealers ? Math.min(maxDealers, eligible.length) : eligible.length;
    return {
      template: { id: template.id, name: template.name, category: template.category, status: template.status },
      eligibleDealers: eligible.length,
      willDraft: count,
      cost: estimateCost(template.category, count),
    };
  }

  /** Warm dealers → PENDING drafts. Always to the queue: a campaign is the biggest blast
   *  this channel can fire, so a person sees it first. */
  async campaign(input: { templateId: string; maxDealers?: number; dealerIds?: string[] }) {
    const template = await this.templates.load(input.templateId);
    if (template.status !== 'APPROVED') {
      throw new BadRequestException(`template "${template.name}" is ${template.status} — Meta must approve it before anyone can be sent it`);
    }
    const done = await this.alreadyDraftedFor(template.id);
    const dealers = (await eligibleWarmDealers(this.prisma, { dealerIds: input.dealerIds }))
      .filter((d) => !done.has(d.id))
      .slice(0, input.maxDealers && input.maxDealers > 0 ? input.maxDealers : undefined);

    let created = 0;
    for (const dealer of dealers) {
      const params = paramsFor(template.paramKeys, await this.sender.fieldsFor(dealer));
      await this.createDraft(dealer.id, renderTemplate(template.bodyText, params), {
        kind: 'template',
        templateId: template.id,
        params,
      });
      created++;
    }
    return { created, skippedAlreadyDrafted: done.size, cost: estimateCost(template.category, created) };
  }

  /** One template to one dealer, straight into the queue. Refuses a cold dealer up front —
   *  the send guard would too, but "why can't I" is better answered at drafting time. */
  async draftTemplateFor(dealerId: string, templateId: string): Promise<MessageDraft> {
    const template = await this.templates.load(templateId);
    if (template.status !== 'APPROVED') throw new BadRequestException(`template "${template.name}" is ${template.status}, not APPROVED`);
    const dealer = await this.prisma.dealer.findFirst({ where: { id: dealerId }, include: { phones: true } });
    if (!dealer) throw new BadRequestException(`no dealer ${dealerId} in this organization`);
    if (!isWarm(await warmSignalsFor(this.prisma, dealer))) {
      throw new BadRequestException(`${dealer.businessName} has not engaged yet — WhatsApp is the warm channel. Email them first.`);
    }
    if (!pickWhatsAppNumber(dealer.phones)) throw new BadRequestException(`${dealer.businessName} has no valid phone number`);
    const params = paramsFor(template.paramKeys, await this.sender.fieldsFor(dealer));
    return this.createDraft(dealer.id, renderTemplate(template.bodyText, params), { kind: 'template', templateId, params });
  }

  /** A person's reply inside an open session. The caller approves it as that user — the
   *  human writing it is the approver (§9), so it is not an auto-send. */
  async draftReply(dealerId: string, text: string): Promise<MessageDraft> {
    if (!text.trim()) throw new BadRequestException('the reply is empty');
    const conversation = await this.prisma.whatsAppConversation.findFirst({ where: { dealerId } });
    if (!sessionOpen(conversation?.sessionExpiresAt)) {
      throw new BadRequestException(
        'the 24-hour window is closed — WhatsApp only allows an approved template now. They have to message you first to reopen it.',
      );
    }
    return this.createDraft(dealerId, text.trim(), { kind: 'freeform', human: true });
  }

  private createDraft(dealerId: string, draftText: string, payload: WhatsAppDraftPayload): Promise<MessageDraft> {
    return this.prisma.messageDraft.create({
      data: {
        organizationId: getOrgId()!,
        dealerId,
        sourceModule: SOURCE_MODULE,
        draftText,
        templateVariables: payload as never,
        containsFinancialTerms: false,
        requiresApproval: true,
      },
    });
  }
}
