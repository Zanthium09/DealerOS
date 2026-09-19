import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { WHATSAPP_PROVIDER, WhatsAppProvider, WhatsAppProviderError } from '../../providers/whatsapp';
import { WhatsAppInboundService } from './whatsapp-inbound.service';

// Same shim as the email controllers: Nest attaches the raw pre-parse body here when
// bootstrapped with { rawBody: true } (main.ts).
type RawBodyRequest = { rawBody?: Buffer };

/**
 * §8 — Meta's webhook. Unauthenticated by session (Meta has none) and authenticated by
 * the X-Hub-Signature-256 HMAC over the genuine raw bytes instead. No TenantAuthGuard
 * here, deliberately: a webhook is received before any org context exists.
 */
@Controller('outreach-whatsapp/webhook')
export class WhatsAppWebhookController {
  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    private readonly inbound: WhatsAppInboundService,
  ) {}

  /** Meta's one-time handshake when the callback URL is registered. */
  @Get()
  verify(@Query() query: Record<string, string | undefined>): string {
    const challenge = this.whatsapp.verifyChallenge(query);
    if (challenge === null) throw new ForbiddenException('verify token does not match');
    return challenge;
  }

  @Post()
  async receive(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>): Promise<{ ok: true; events: number }> {
    if (!req.rawBody) throw new BadRequestException('missing raw body');
    try {
      const { events } = await this.inbound.handle(req.rawBody, headers);
      return { ok: true, events };
    } catch (err) {
      // A bad signature is the caller's fault and must not be retried into a 500 loop.
      if (err instanceof WhatsAppProviderError && /signature|WHATSAPP_APP_SECRET/.test(err.message)) {
        throw new UnauthorizedException(err.message);
      }
      throw err;
    }
  }
}
