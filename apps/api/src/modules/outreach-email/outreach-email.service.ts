import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { ApprovalService } from '../../core/approval';
import { alreadyDrafted, ColdDraftService } from './cold-draft.service';
import { eligibleForColdOutreach } from './eligibility';
import { EmailSendError, EmailSendService } from './send.service';
import { SequenceService } from './sequence.service';

export type ColdOutreachResult = { drafted: number; sent: number; skipped: { dealerId: string; reason: string }[] };

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

  async runColdOutreach(organizationId: string): Promise<ColdOutreachResult> {
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId } });
    if (!org) throw new Error(`no organization ${organizationId}`);

    const dealers = await eligibleForColdOutreach(this.prisma);
    const result: ColdOutreachResult = { drafted: 0, sent: 0, skipped: [] };

    for (const dealer of dealers) {
      if (await alreadyDrafted(this.prisma, dealer.id)) continue;

      const draft = await this.coldDraft.draft(dealer, org.name);
      result.drafted++;

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
