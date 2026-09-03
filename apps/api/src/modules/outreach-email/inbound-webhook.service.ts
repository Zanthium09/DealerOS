import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { EMAIL_PROVIDER, EmailProvider, htmlToPlainText } from '../../providers/email';
import { InboundEmailError, InboundEmailService } from './inbound.service';

/**
 * §6/§8 — a dealer's reply, receiving side. Same shape as webhook.service.ts (the
 * outbound delivery-events counterpart), kept as its own service for the same
 * reason that one is: the controller stays a thin shell over @Req()/@Headers(), and
 * this is testable directly with a synthetic Buffer, with no real HTTP server or
 * network call needed (§13).
 *
 * Verified over the genuine raw bytes (§8 — a re-serialised body will not match),
 * which is why this takes a Buffer, not a parsed body. Idempotent on
 * WebhookEvent(provider, providerEventId), same as every other webhook in this app.
 *
 * InboundEmailService.handle() resolves its own org context from the reply's
 * headers (message-id.ts) — this service never needs to know which organization a
 * reply belongs to before calling it.
 */
@Injectable()
export class ResendInboundWebhookService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly inbound: InboundEmailService,
  ) {}

  async handle(rawBody: Buffer, headers: Record<string, string>): Promise<{ deduped?: true }> {
    const parsed = this.email.parseInboundWebhook(rawBody, headers);
    if (!parsed) return {}; // an event type this app does not process

    try {
      await this.prisma.webhookEvent.create({
        data: { provider: 'resend-inbound', providerEventId: parsed.providerEventId, payload: { emailId: parsed.emailId } },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return { deduped: true }; // already processed (§8)
      throw err;
    }

    try {
      const full = await this.email.fetchReceivedEmail(parsed.emailId);
      await this.inbound.handle({
        headers: full.headers,
        subject: full.subject,
        body: full.text ?? (full.html ? htmlToPlainText(full.html) : ''),
        fromAddress: full.fromAddress,
      });
      await this.prisma.webhookEvent.update({
        where: { provider_providerEventId: { provider: 'resend-inbound', providerEventId: parsed.providerEventId } },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookEvent.update({
        where: { provider_providerEventId: { provider: 'resend-inbound', providerEventId: parsed.providerEventId } },
        data: { error: message },
      });
      // InboundEmailError means this reply genuinely cannot be threaded to a send
      // this app made (e.g. someone emailing the inbox cold) — retrying changes
      // nothing, so the row stays as the permanent record and the caller answers
      // 400, no retry expected.
      //
      // Anything else is a real bug or a transient failure (a DB hiccup, a fetch
      // timeout). The WebhookEvent row committed above is what made this
      // idempotent, but it ALSO means a genuine failure here left the event
      // marked "seen" forever with the reply never actually recorded — Resend's
      // retry would hit the dedupe check first and give up without ever calling
      // inbound.handle() again. Deleting the row on this path is what makes a
      // real reply recoverable instead of being silently swallowed the one time
      // something server-side goes wrong.
      if (!(err instanceof InboundEmailError)) {
        await this.prisma.webhookEvent
          .delete({ where: { provider_providerEventId: { provider: 'resend-inbound', providerEventId: parsed.providerEventId } } })
          .catch(() => {});
      }
      throw err;
    }
    return {};
  }
}
