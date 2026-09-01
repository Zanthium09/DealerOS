import { BadRequestException, Controller, Get, Headers, Post, Query, Body, Req } from '@nestjs/common';
import { OutreachEmailWebhookService } from './webhook.service';
import { UnsubscribeEndpointService, UnsubscribeError } from './unsubscribe-endpoint.service';
import { InboundEmailError } from './inbound.service';
import { ResendInboundWebhookService } from './inbound-webhook.service';

// Same as core/webhooks/webhooks.controller.ts's own shim: Nest attaches the raw
// pre-parse body here when bootstrapped with { rawBody: true } (main.ts). Deliberately
// untyped as express.Request — no @types/express dependency for one field.
type RawBodyRequest = { rawBody?: Buffer };

/**
 * §8 — the HTTP handler only persists and enqueues (here: persists via WebhookEvent's
 * unique constraint and processes inline, since core/webhooks' async ingestion did not
 * exist yet — see the module report for the wiring note).
 */
@Controller('outreach-email')
export class OutreachEmailController {
  constructor(
    private readonly webhooks: OutreachEmailWebhookService,
    private readonly unsubscribe: UnsubscribeEndpointService,
    private readonly inboundWebhook: ResendInboundWebhookService,
  ) {}

  @Post('webhooks/resend')
  async resendWebhook(@Body() body: unknown, @Headers('svix-signature') signature: string): Promise<{ ok: true }> {
    if (!signature) throw new BadRequestException('missing webhook signature');
    await this.webhooks.handle(body, signature);
    return { ok: true };
  }

  /**
   * §6/§8 — a dealer's reply. Verified over the genuine raw bytes (§8), not the
   * re-parsed body — this reads req.rawBody, not @Body(), for exactly the reason §8
   * always names: a re-serialised body will not match the signature. All the
   * orchestration (verify, dedupe, fetch, hand off) lives in
   * ResendInboundWebhookService — this stays a thin shell over @Req()/@Headers().
   */
  @Post('webhooks/resend-inbound')
  async resendInboundWebhook(
    @Req() req: RawBodyRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<{ ok: true; deduped?: true }> {
    if (!req.rawBody) throw new BadRequestException('missing raw body');
    try {
      const result = await this.inboundWebhook.handle(req.rawBody, headers);
      return { ok: true, ...result };
    } catch (err) {
      // A reply that doesn't thread back to anything this app sent (e.g. someone
      // emailing the address cold) is a bad request, not a server fault — the
      // WebhookEvent row already recorded that we received it.
      if (err instanceof InboundEmailError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  // GET, not POST: it is the link a dealer clicks from their mail client, not a form
  // submit (§6 — List-Unsubscribe-Post also offers the one-click POST variant, which
  // mail providers call server-to-server; both land here).
  @Get('unsubscribe')
  async unsubscribeLink(@Query('token') token: string): Promise<{ ok: true }> {
    if (!token) throw new BadRequestException('missing token');
    try {
      await this.unsubscribe.unsubscribe(token);
    } catch (err) {
      if (err instanceof UnsubscribeError) throw new BadRequestException(err.message);
      throw err;
    }
    return { ok: true };
  }

  @Post('unsubscribe')
  async unsubscribePost(@Query('token') token: string): Promise<{ ok: true }> {
    return this.unsubscribeLink(token);
  }
}
