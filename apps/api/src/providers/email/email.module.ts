import { Global, Module } from '@nestjs/common';
import { EMAIL_PROVIDER } from './email.provider';
import { ResendProvider } from './resend.provider';

// §1.7 / §6 — the only way to reach Resend. Swapping providers is changing useClass
// here to SesProvider, per the stub in ses.provider.ts.
@Global()
@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: ResendProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
