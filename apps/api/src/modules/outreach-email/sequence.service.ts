import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, ConnectionOptions } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { ApprovalService } from '../../core/approval';
import { ColdDraftService } from './cold-draft.service';
import { EmailSendService } from './send.service';
import { currentConsentState, isEligibleForEmail } from './consent';

export const SEQUENCE_QUEUE_NAME = 'outreach-email-sequence';
export const SEQUENCE_STEPS = 'OUTREACH_EMAIL_SEQUENCE_STEPS';
/** [delay before follow-up 1, delay before follow-up 2] — real days in production,
 *  overridden with short ms delays in tests (§13 needs the halt to be observable
 *  inside a test timeout, not three and seven real days later). */
export type SequenceSteps = readonly [number, number];
export const DEFAULT_SEQUENCE_STEPS_MS: SequenceSteps = [3 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

// BullMQ rejects a custom job id containing ':' (it reserves that separator for its
// own internal key names), so this cannot reuse the seq:org:dealer:step shape used
// elsewhere in comments — '.' is safe and still fully deterministic per (org, dealer, step).
function jobId(organizationId: string, dealerId: string, step: 1 | 2): string {
  return `seq.${organizationId}.${dealerId}.${step}`;
}

type JobData = { organizationId: string; dealerId: string; initialInteractionEventId: string; step: 1 | 2 };

/**
 * §6 — "initial → follow-up 1 (N days) → follow-up 2 (M days). A reply, click, bounce
 * or opt-out halts remaining steps immediately."
 *
 * Cancellation is NOT best-effort in one way that matters: `cancel()` removes the
 * delayed BullMQ job (so most halts never even fire the worker), but the worker also
 * re-checks eligibility straight from the database — current consent, pipeline stage,
 * and any CLICKED/INBOUND InteractionEvent since the initial send — immediately before
 * drafting or sending anything. BullMQ's own `remove()` can race a job that is already
 * being picked up by a worker (removal and pickup are not one atomic operation), so if
 * cancellation alone were the guarantee, that race would let a follow-up slip through
 * exactly when a reply and a scheduled job land at the same moment. The database
 * recheck closes that: even a job that fires anyway is a no-op unless the DB — not the
 * queue — still says it should go out. Halting is therefore guaranteed by the data,
 * with the queue removal as the (usually sufficient) fast path.
 */
@Injectable()
export class SequenceService implements OnModuleDestroy {
  private readonly queue: Queue<JobData>;
  private readonly worker: Worker<JobData>;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly coldDraft: ColdDraftService,
    private readonly approval: ApprovalService,
    private readonly send: EmailSendService,
    @Inject(SEQUENCE_STEPS) private readonly steps: SequenceSteps,
    @Inject('OUTREACH_EMAIL_REDIS_CONNECTION') connection: ConnectionOptions,
  ) {
    this.queue = new Queue<JobData>(SEQUENCE_QUEUE_NAME, { connection });
    this.worker = new Worker<JobData>(SEQUENCE_QUEUE_NAME, (job) => this.process(job.data), { connection });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }

  /** Called right after the initial cold email sends successfully. */
  async start(organizationId: string, dealerId: string, initialInteractionEventId: string): Promise<void> {
    await this.queue.add(
      'follow-up',
      { organizationId, dealerId, initialInteractionEventId, step: 1 },
      { jobId: jobId(organizationId, dealerId, 1), delay: this.steps[0] },
    );
  }

  /** §6 — the fast path half of the halt guarantee. Removing a job that already fired
   *  or was already removed is a no-op, never an error. */
  async cancel(organizationId: string, dealerId: string): Promise<void> {
    await this.queue.remove(jobId(organizationId, dealerId, 1));
    await this.queue.remove(jobId(organizationId, dealerId, 2));
  }

  private async process(data: JobData): Promise<void> {
    await runWithOrg(data.organizationId, async () => {
      const stillEligible = await this.recheckEligibility(data.dealerId, data.initialInteractionEventId);
      if (!stillEligible) return;

      const dealer = await this.prisma.dealer.findFirst({ where: { id: data.dealerId } });
      if (!dealer) return;
      const org = await this.prisma.organization.findFirst({ where: { id: data.organizationId } });
      if (!org) return;

      const draft = await this.coldDraft.draft(dealer, org.name);
      const approved = draft.requiresApproval ? null : await this.approval.autoSend(draft.id);
      if (!approved) return; // needs a human — the queue, not this worker, sends it

      await this.send.sendApprovedDraft(approved.id);

      if (data.step === 1) {
        await this.queue.add(
          'follow-up',
          { ...data, step: 2 },
          { jobId: jobId(data.organizationId, data.dealerId, 2), delay: this.steps[1] },
        );
      }
    });
  }

  private async recheckEligibility(dealerId: string, initialInteractionEventId: string): Promise<boolean> {
    const dealer = await this.prisma.dealer.findFirst({ where: { id: dealerId } });
    // A HUMAN_REPLY moves the dealer off NEW (pipeline.ts) — that alone halts follow-ups.
    if (!dealer || dealer.pipelineStage !== 'NEW') return false;

    const consent = await currentConsentState(this.prisma, dealerId, 'EMAIL');
    if (!isEligibleForEmail(consent)) return false;

    const initial = await this.prisma.interactionEvent.findFirst({ where: { id: initialInteractionEventId } });
    if (!initial) return true;

    const laterTouch = await this.prisma.interactionEvent.count({
      where: {
        dealerId,
        channel: 'EMAIL',
        createdAt: { gt: initial.createdAt },
        OR: [{ status: 'CLICKED' }, { direction: 'INBOUND' }],
      },
    });
    return laterTouch === 0;
  }
}
