import { BadRequestException, Controller, Get, Headers, Post, Query, Body } from '@nestjs/common';
import { OutreachEmailWebhookService } from './webhook.service';
import { UnsubscribeEndpointService, UnsubscribeError } from './unsubscribe-endpoint.service';

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
  ) {}

  @Post('webhooks/resend')
  async resendWebhook(@Body() body: unknown, @Headers('svix-signature') signature: string): Promise<{ ok: true }> {
    if (!signature) throw new BadRequestException('missing webhook signature');
    await this.webhooks.handle(body, signature);
    return { ok: true };
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
