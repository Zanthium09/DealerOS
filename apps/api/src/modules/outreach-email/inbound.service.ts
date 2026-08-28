import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { AI_PROVIDER, AIProvider } from '../../providers/ai/ai.provider';
import { AuditService } from '../../core/audit';
import { InboundEmail, classifyReply } from './reply-classify';
import { findThreadedMessageId } from './message-id';
import { writeConsent } from './consent';
import { transitionPipelineStage } from './pipeline';
import { SequenceService } from './sequence.service';

export class InboundEmailError extends Error {}

/**
 * §6 — an inbound email arrives, threads back to the send it replies to (message-id.ts),
 * gets classified (reply-classify.ts), and only then acts:
 *   - any classification halts the sequence — a live mailbox replying at all, even an
 *     autoresponder, is reason enough to stop bombarding it with follow-ups (§6's halt
 *     list: "a reply, click, bounce or opt-out", not qualified to human replies only).
 *   - only HUMAN_REPLY moves the dealer NEW → CONTACTED (§5.2, §10.5-style caution:
 *     an out-of-office must never look like interest).
 *   - UNSUBSCRIBE_REQUEST also writes ConsentLog OPTED_OUT + Suppression, same as the
 *     one-click link.
 */
@Injectable()
export class InboundEmailService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
  ) {}

  async handle(email: InboundEmail): Promise<void> {
    const threaded = findThreadedMessageId(email.headers);
    if (!threaded) {
      throw new InboundEmailError('inbound email does not thread back to a message this module sent');
    }
    const { organizationId, interactionEventId } = threaded;

    await runWithOrg(organizationId, async () => {
      const original = await this.prisma.interactionEvent.findFirst({ where: { id: interactionEventId } });
      if (!original) throw new InboundEmailError(`no InteractionEvent ${interactionEventId} in this org`);
      const dealerId = original.dealerId;

      const classification = await classifyReply(email, this.ai);

      await this.prisma.interactionEvent.create({
        data: {
          dealerId,
          channel: 'EMAIL',
          direction: 'INBOUND',
          messageDraftId: original.messageDraftId,
          status: 'REPLIED',
          body: email.body,
        } as Prisma.InteractionEventUncheckedCreateInput,
      });

      // §6 — every classification halts remaining sequence steps.
      await this.sequence.cancel(organizationId, dealerId);

      if (classification === 'UNSUBSCRIBE_REQUEST') {
        await writeConsent(this.prisma, {
          organizationId,
          dealerId,
          channel: 'EMAIL',
          state: 'OPTED_OUT',
          source: 'EXPLICIT_UNSUBSCRIBE',
        });
        await this.prisma.suppression.create({
          data: { email: email.fromAddress, reason: 'inbound unsubscribe request' } as Prisma.SuppressionUncheckedCreateInput,
        });
        return;
      }

      if (classification === 'HUMAN_REPLY') {
        await transitionPipelineStage(this.prisma, this.audit, {
          organizationId,
          dealerId,
          from: 'NEW',
          to: 'CONTACTED',
          reason: 'HUMAN_REPLY to cold outreach email (§5.2)',
        });
      }
      // AUTO_REPLY / BOUNCE: logged and halted, no pipeline transition.
    });
  }
}
