import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { EMAIL_PROVIDER, EmailProvider, EmailWebhookEvent } from '../../providers/email';
import { writeConsent } from './consent';
import { SequenceService } from './sequence.service';

/**
 * §8 — provider webhooks (delivered/opened/clicked/bounced/complained). Idempotent on
 * `WebhookEvent(provider, providerEventId)`; org and dealer never come from a database
 * lookup — they travel in the event's `tags`, set at send time (message-id.ts's doc
 * comment explains why that is possible at all under §1.3's scoping rules).
 */
@Injectable()
export class OutreachEmailWebhookService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly sequence: SequenceService,
  ) {}

  /** HTTP handler calls this after only persisting the raw payload (§8: the handler
   *  persists and enqueues, processing is async — the WebhookEvent row IS the queue
   *  entry here since core/webhooks' BullMQ ingestion did not exist yet; see report). */
  async handle(rawPayload: unknown, signature: string): Promise<void> {
    const events = this.email.parseWebhook(rawPayload, signature);
    for (const event of events) await this.processOne(event);
  }

  private async processOne(event: EmailWebhookEvent): Promise<void> {
    // Unscoped by design: WebhookEvent carries no organizationId (tenancy.ts's
    // EXEMPT_MODELS — a webhook is received before any org context exists).
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: 'resend', providerEventId: event.providerEventId, payload: event as any },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return; // already processed (§8) — ack and return early
      throw err;
    }

    const organizationId = event.tags.organizationId;
    if (!organizationId) return; // nothing to attribute the touch to

    try {
      await runWithOrg(organizationId, async () => {
        const dealerId = event.tags.dealerId;
        const messageDraftId = event.tags.messageDraftId ?? null;
        if (!dealerId) return;

        await this.prisma.interactionEvent.create({
          data: {
            dealerId,
            channel: 'EMAIL',
            direction: 'OUTBOUND',
            messageDraftId,
            providerMessageId: event.providerMessageId,
            status: event.type,
            // A delivery-status touch has no new body of its own — it is the original
            // send's outcome, so the SENT row already carries "what exactly did we send".
            body: '',
          } as Prisma.InteractionEventUncheckedCreateInput,
        });

        if (event.type === 'BOUNCED') {
          await writeConsent(this.prisma, {
            organizationId,
            dealerId,
            channel: 'EMAIL',
            state: 'OPTED_OUT',
            source: 'BOUNCE',
          });
          await this.sequence.cancel(organizationId, dealerId);
        }
        if (event.type === 'CLICKED') {
          await this.sequence.cancel(organizationId, dealerId);
        }
      });
      await this.prisma.webhookEvent.update({
        where: { provider_providerEventId: { provider: 'resend', providerEventId: event.providerEventId } },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      // Same reasoning as inbound-webhook.service.ts: the WebhookEvent row above
      // already committed for idempotency, so a failure here (not a dedupe hit —
      // those already returned) would otherwise mark this delivery event "seen"
      // forever with nothing actually recorded, and Resend's retry would give up
      // at the dedupe check before ever reaching this code again. Delete it so a
      // real failure is retriable instead of silently dropping an OPENED/CLICKED/
      // BOUNCED/REPLIED touch.
      await this.prisma.webhookEvent
        .delete({ where: { provider_providerEventId: { provider: 'resend', providerEventId: event.providerEventId } } })
        .catch(() => {});
      throw err;
    }
  }
}
