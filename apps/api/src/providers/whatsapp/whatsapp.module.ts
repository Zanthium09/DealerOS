import { Global, Module } from '@nestjs/common';
import { CloudApiProvider } from './cloud-api.provider';
import { WHATSAPP_PROVIDER } from './whatsapp.provider';

// §1.7 — the only way to reach Meta. Unconfigured (no WHATSAPP_ACCESS_TOKEN) it still
// boots: every send fails loudly with "WhatsApp is not configured" rather than the app
// refusing to start over a channel that is not switched on yet.
@Global()
@Module({
  providers: [{ provide: WHATSAPP_PROVIDER, useClass: CloudApiProvider }],
  exports: [WHATSAPP_PROVIDER],
})
export class WhatsAppProviderModule {}
