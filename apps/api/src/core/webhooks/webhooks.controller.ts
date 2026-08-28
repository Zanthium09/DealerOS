import { Body, Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

// Nest attaches the raw pre-parse body here when bootstrapped with { rawBody: true }
// (main.ts) — deliberately untyped as `express.Request` (see tenancy.middleware.ts for
// the same choice): no @types/express dependency needed for one field.
type RawBodyRequest = { rawBody?: Buffer };

// §8 — no auth guard: a webhook arrives with no session, no org context (WebhookEvent
// is exempt from tenancy, §1.3/§4). The signature check inside WebhooksService.ingest
// IS the auth for this route.
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ) {
    // req.rawBody is populated by Nest's body parser only when the app is bootstrapped
    // with { rawBody: true } (see main.ts) — the RAW bytes, captured before JSON
    // parsing, which is what the signature must be computed over (§8: a re-serialised
    // body will not match).
    const result = await this.webhooks.ingest(provider, req.rawBody, headers, body);
    return { ok: true, deduped: result.deduped };
  }
}
