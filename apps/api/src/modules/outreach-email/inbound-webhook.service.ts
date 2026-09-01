import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { EMAIL_PROVIDER, EmailProvider, htmlToPlainText } from '../../providers/email';
import { InboundEmailService } from './inbound.service';

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

    const full = await this.email.fetchReceivedEmail(parsed.emailId);
    await this.inbound.handle({
      headers: full.headers,
      subject: full.subject,
      body: full.text ?? (full.html ? htmlToPlainText(full.html) : ''),
      fromAddress: full.fromAddress,
    });
    return {};
  }
}
