import { Inject, Injectable } from '@nestjs/common';
import { DraftStatus, MessageDraft, Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../tenancy/tenancy.module';
import { AuditAction, AuditService } from '../audit';
import { AUTO_SEND_RULES, AutoSendRule } from './auto-send';

/**
 * §9 — one Approval Queue, shared by every module. Modules do not each invent their
 * own screen; they write a MessageDraft (via core/drafting) and it appears here.
 *
 * This service does NOT send. It decides. Sending is a channel module's job and does
 * not exist yet — which is why the terminal statuses (AUTO_SENT, EDITED_AND_SENT) are
 * never written here: nothing may claim a message was sent before one was.
 *
 *   PENDING ──approve────────────► APPROVED   (approvedByUserId)
 *   PENDING ──editAndApprove─────► APPROVED   (approvedByUserId, text replaced)
 *   PENDING ──autoSend───────────► APPROVED   (autoSendRuleId, no human)
 *   PENDING ──reject─────────────► REJECTED
 *
 * PENDING is the only state with outgoing edges. Everything else is terminal here, so
 * an approved, rejected or already-sent draft cannot be approved a second time — the
 * check is a conditional UPDATE, not a read-then-write, so two concurrent approvals
 * cannot both win and enqueue the same message twice.
 */

export type DealerGroup = {
  dealerId: string;
  businessName: string;
  drafts: MessageDraft[];
};

export class ApprovalError extends Error {}

// audit.actions.ts owns this list, but DRAFT_APPROVED / DRAFT_AUTO_SENT are the only
// two it declares (§9 names only sends). A rejection is a transition and §9 wants
// every transition audited, so it is written under its own action here.
// ponytail: move this constant into audit.actions.ts when that file is next touched.
const DRAFT_REJECTED = 'DRAFT_REJECTED' as AuditAction;

@Injectable()
export class ApprovalService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    @Inject(AUTO_SEND_RULES) private readonly rules: readonly AutoSendRule[],
  ) {}

  /** Configured thresholds, for the UI's "why did this skip the queue" answer. */
  autoSendRules(): readonly AutoSendRule[] {
    return this.rules;
  }

  /**
   * §9 — pending drafts across all modules, grouped by dealer, oldest dealer first.
   * The org filter is the tenancy client's, not a where clause anyone can forget.
   */
  async pending(filter: { sourceModule?: string } = {}): Promise<DealerGroup[]> {
    const drafts = await this.prisma.messageDraft.findMany({
      where: {
        status: DraftStatus.PENDING,
        ...(filter.sourceModule ? { sourceModule: filter.sourceModule } : {}),
      },
      orderBy: { createdAt: 'asc' },
      // §9 — "full dealer history on one screen". The dealer's name travels with the
      // group so the queue is not N+1 lookups away from being readable.
      include: { dealer: { select: { businessName: true } } },
    });

    const groups = new Map<string, DealerGroup>();
    for (const { dealer, ...draft } of drafts) {
      const group = groups.get(draft.dealerId) ?? {
        dealerId: draft.dealerId,
        businessName: dealer.businessName,
        drafts: [],
      };
      group.drafts.push(draft as MessageDraft);
      groups.set(draft.dealerId, group);
    }
    return [...groups.values()];
  }

  /** A human approves it as drafted. */
  approve(draftId: string, userId: string): Promise<MessageDraft> {
    return this.transition(draftId, {
      data: { status: DraftStatus.APPROVED, approvedByUserId: userId },
      action: AuditAction.DRAFT_APPROVED,
      actorType: 'USER',
      actorId: userId,
      metadata: { approvedByUserId: userId },
    });
  }

  /**
   * A human rewrites it, then approves it. The new text is stored as sent-worthy text
   * verbatim: a person typing a number is §1.5 working as designed, unlike a model
   * doing it. The previous text goes into the audit row so the edit is reviewable.
   */
  async editAndApprove(draftId: string, userId: string, draftText: string): Promise<MessageDraft> {
    if (!draftText.trim()) throw new ApprovalError('edited text is empty');
    const before = await this.load(draftId);
    return this.transition(draftId, {
      data: { status: DraftStatus.APPROVED, approvedByUserId: userId, draftText },
      action: AuditAction.DRAFT_APPROVED,
      actorType: 'USER',
      actorId: userId,
      metadata: { approvedByUserId: userId, edited: true, previousText: before.draftText },
    });
  }

  reject(draftId: string, userId: string, reason?: string): Promise<MessageDraft> {
    return this.transition(draftId, {
      data: { status: DraftStatus.REJECTED, approvedByUserId: null },
      action: DRAFT_REJECTED,
      actorType: 'USER',
      actorId: userId,
      metadata: { rejectedByUserId: userId, ...(reason ? { reason } : {}) },
    });
  }

  /**
   * §9 — the deterministic path. Only a draft that core/drafting already marked
   * `requiresApproval: false` under a named rule may take it, and the rule is
   * re-checked here so a hand-written row cannot walk through.
   */
  async autoSend(draftId: string): Promise<MessageDraft> {
    const draft = await this.load(draftId);
    const rule = this.rules.find((r) => r.id === draft.autoSendRuleId);
    if (draft.requiresApproval || !rule) {
      throw new ApprovalError(
        `draft ${draftId} needs a human — it carries no valid auto-send rule (§9).`,
      );
    }
    return this.transition(draftId, {
      data: { status: DraftStatus.APPROVED },
      action: AuditAction.DRAFT_AUTO_SENT,
      // No human decided this, so no human is credited with it.
      actorType: 'SYSTEM',
      actorId: null,
      metadata: { autoSendRuleId: rule.id, sourceModule: draft.sourceModule },
    });
  }

  private async load(draftId: string): Promise<MessageDraft> {
    // Scoped by the tenancy client: another org's id simply does not exist here.
    const draft = await this.prisma.messageDraft.findFirst({ where: { id: draftId } });
    if (!draft) throw new ApprovalError(`no draft ${draftId} in this organization`);
    return draft;
  }

  /**
   * The state machine, and §9's audit requirement, in one place — so there is no path
   * that changes a draft's status without recording who or what did it. Both writes
   * are in one transaction: an audit row that rolled back would be a lie, and a
   * status change without one is the thing §9 forbids.
   */
  private async transition(
    draftId: string,
    step: {
      data: Prisma.MessageDraftUncheckedUpdateManyInput;
      action: AuditAction;
      actorType: 'USER' | 'SYSTEM';
      actorId: string | null;
      metadata: Prisma.InputJsonObject;
    },
  ): Promise<MessageDraft> {
    return this.prisma.$transaction(async (tx) => {
      // Conditional update = the state machine. PENDING is the only legal source
      // state, and the database decides, so a race cannot approve twice.
      const { count } = await tx.messageDraft.updateMany({
        where: { id: draftId, status: DraftStatus.PENDING },
        data: step.data,
      });

      if (count === 0) {
        const current = await tx.messageDraft.findFirst({ where: { id: draftId } });
        throw new ApprovalError(
          current
            ? `draft ${draftId} is ${current.status}, not PENDING — it cannot be decided again (§9).`
            : `no draft ${draftId} in this organization`,
        );
      }

      const draft = await tx.messageDraft.findFirstOrThrow({ where: { id: draftId } });
      await this.audit.record(
        {
          actorType: step.actorType,
          actorId: step.actorId,
          organizationId: draft.organizationId,
          entityType: 'MessageDraft',
          entityId: draft.id,
          action: step.action,
          metadata: { ...step.metadata, status: draft.status },
        },
        tx,
      );
      return draft;
    });
  }
}
