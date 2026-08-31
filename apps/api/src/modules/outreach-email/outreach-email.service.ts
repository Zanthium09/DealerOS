import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { ApprovalService } from '../../core/approval';
import { alreadyDrafted, ColdDraftService } from './cold-draft.service';
import { eligibleForColdOutreach, OutreachSegmentFilter } from './eligibility';
import { EmailSendError, EmailSendService } from './send.service';
import { SequenceService } from './sequence.service';

export type ColdOutreachResult = { drafted: number; sent: number; skipped: { dealerId: string; reason: string }[] };

export type ColdOutreachOptions = {
  /** "How many to send at each press" — stop after drafting this many eligible
   *  dealers, even if more are eligible. Undefined = no cap beyond the daily send
   *  limit that EmailSendService already enforces (§6). */
  maxDealers?: number;
  segmentFilter?: OutreachSegmentFilter;
  /** Every draft this run produces requires a human, even ones with zero financial
   *  terms that would otherwise auto-send. A manual override for "review everything
   *  from this batch before it goes out" — the queue is the same one §9 already has,
   *  this just routes every draft there instead of some of them. */
  forceReview?: boolean;
};

/**
 * §5.2 — the whole flow, tied together: eligible NEW dealers → draft → auto-send
 * where the draft carries no financial terms → sent → sequence started.
 *
 * Stops early on a daily-cap error rather than throwing per dealer: a partial batch
 * today plus the rest tomorrow is the intended behaviour of §6's warmup ramp, not a
 * failure.
 */
@Injectable()
export class OutreachEmailService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly coldDraft: ColdDraftService,
    private readonly approval: ApprovalService,
    private readonly send: EmailSendService,
    private readonly sequence: SequenceService,
  ) {}

  async runColdOutreach(
    organizationId: string,
    options: ColdOutreachOptions = {},
  ): Promise<ColdOutreachResult> {
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId } });
    if (!org) throw new Error(`no organization ${organizationId}`);

    const dealers = await eligibleForColdOutreach(this.prisma, options.segmentFilter);
    const result: ColdOutreachResult = { drafted: 0, sent: 0, skipped: [] };

    for (const dealer of dealers) {
      if (options.maxDealers !== undefined && result.drafted >= options.maxDealers) break;
      if (await alreadyDrafted(this.prisma, dealer.id)) continue;

      let draft = await this.coldDraft.draft(dealer, org.name);
      result.drafted++;

      if (options.forceReview && !draft.requiresApproval) {
        // Manual override: this batch goes to a human regardless of content. Clearing
        // autoSendRuleId too — a rule id sitting on a draft that requiresApproval is
        // exactly the "hand-written row" ApprovalService.autoSend already refuses,
        // this just makes the row internally consistent instead of relying on that
        // refusal as the only thing stopping it.
        draft = await this.prisma.messageDraft.update({
          where: { id: draft.id },
          data: { requiresApproval: true, autoSendRuleId: null },
        });
      }

      if (draft.requiresApproval) continue; // needs a human — leave PENDING in the queue

      try {
        const approved = await this.approval.autoSend(draft.id);
        const event = await this.send.sendApprovedDraft(approved.id);
        result.sent++;
        await this.sequence.start(organizationId, dealer.id, event.id);
      } catch (err) {
        if (err instanceof EmailSendError && /daily cap/.test(err.message)) {
          result.skipped.push({ dealerId: dealer.id, reason: 'daily cap reached' });
          break; // every later dealer would hit the same cap
        }
        result.skipped.push({ dealerId: dealer.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return result;
  }
}
