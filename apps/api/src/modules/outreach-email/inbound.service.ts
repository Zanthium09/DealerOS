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
    const threaded = findThreadedMessageId(email.headers) ?? (await this.findByReplyAddress(email.fromAddress));
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

  /**
   * message-id.ts's fast path assumes the Message-ID this app sets survives to the
   * recipient unchanged — verified against two real replies that it does not:
   * Resend sends via AWS SES, and SES REWRITES Message-ID on the way out to its own
   * `<...@REGION.amazonses.com>` format. Both real replies threaded correctly by
   * mail (In-Reply-To matched what the recipient actually received) but that value
   * was never ours to parse.
   *
   * What SES's rewritten id DOES reliably contain is our own `providerMessageId`
   * (the id Resend returned at send time, stored on the SENT InteractionEvent) as a
   * literal substring — e.g. stored `01a06681-9581-7738-...` appeared inside
   * `010601a06681983f-51604413-...@ap-northeast-1.amazonses.com`. So: strip
   * non-hex characters from both sides and look for one inside the other, scanned
   * across recent sends rather than matched by an exact key.
   *
   * This is inherently a bootstrap lookup — which org a reply belongs to is exactly
   * what it has to determine, so no org context can exist yet to query through the
   * scoped client (tenancy.ts refuses InteractionEvent without one, correctly, and
   * even a platform context is barred from tenant tables by §9A.2 — there is no
   * scoped way to ask this question). Raw SQL bypasses the tenancy extension
   * entirely, same as DedupService's fuzzy match, which is unscoped for the same
   * structural reason; the WHERE clause here is the only thing keeping it correct.
   *
   * An earlier version of this fallback tried to match a substring of the
   * providerMessageId Resend returns inside SES's rewritten Message-ID, on the
   * theory that Resend embeds it. Checked against two real replies: it does not —
   * the two ids only share a short prefix because both are timestamp-ordered ids
   * minted in the same instant, not because one contains the other. That match
   * would have silently threaded replies onto the wrong send once two dealers
   * happened to be emailed close enough together in time. Matching on the
   * reply's own From address against who we actually sent to is what those same
   * two real replies confirmed works: the address on the wire matched the stored
   * DealerEmail exactly, in both cases.
   *
   * ponytail: "most recent send to this address," not "the specific send this is
   * a reply to" — indistinguishable from the address alone if the same dealer
   * was emailed more than once. Good enough at this app's volume; revisit if a
   * dealer ever gets a second campaign before replying to the first.
   */
  private async findByReplyAddress(
    fromAddress: string,
  ): Promise<{ organizationId: string; interactionEventId: string } | null> {
    const address = (fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress).trim().toLowerCase();
    if (!address) return null;

    const rows = await this.prisma.$queryRaw<{ id: string; organizationId: string }[]>`
      SELECT ie.id, ie."organizationId"
      FROM "InteractionEvent" ie
      JOIN "DealerEmail" de ON de."dealerId" = ie."dealerId" AND de."organizationId" = ie."organizationId"
      WHERE ie.channel = 'EMAIL' AND ie.direction = 'OUTBOUND' AND lower(de.address) = ${address}
      ORDER BY ie."createdAt" DESC
      LIMIT 1
    `;
    const hit = rows[0];
    return hit ? { organizationId: hit.organizationId, interactionEventId: hit.id } : null;
  }
}
