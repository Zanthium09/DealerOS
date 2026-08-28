import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit';
import { DraftingModule } from '../../core/drafting';
import { AiModule } from '../../providers/ai';
import { EmailModule } from '../../providers/email';
import { OutreachEmailController } from './outreach-email.controller';
import { OutreachEmailService } from './outreach-email.service';
import { ColdDraftService } from './cold-draft.service';
import { EmailSendService, EMAIL_SEND_CONFIG, EmailSendConfig } from './send.service';
import { SequenceService, SEQUENCE_STEPS, DEFAULT_SEQUENCE_STEPS_MS } from './sequence.service';
import { OutreachEmailWebhookService } from './webhook.service';
import { InboundEmailService } from './inbound.service';
import { UnsubscribeEndpointService } from './unsubscribe-endpoint.service';
import { AlwaysAllowThrottle, KILL_SWITCH, NeverPausedKillSwitch, SEND_THROTTLE } from './ports';

/**
 * §5.2 / §11 step 5. Deliberately NOT imported into AppModule here — the task that
 * built this module was told not to edit app.module.ts; whoever wires it in decides
 * where core/throttle and core/killswitch (built concurrently) plug into SEND_THROTTLE
 * / KILL_SWITCH below, by overriding those two providers.
 */
@Module({
  // ApprovalModule is NOT imported here: AppModule's ApprovalModule.forRoot(...) is
  // global (approval.module.ts), so ApprovalService/AUTO_SEND_RULES are already
  // visible. Importing the plain module again would create a second, disconnected
  // empty-rules instance — the exact bug that shipped once already this phase.
  imports: [AuditModule, DraftingModule, AiModule, EmailModule],
  controllers: [OutreachEmailController],
  providers: [
    OutreachEmailService,
    ColdDraftService,
    EmailSendService,
    SequenceService,
    OutreachEmailWebhookService,
    InboundEmailService,
    UnsubscribeEndpointService,
    { provide: SEND_THROTTLE, useClass: AlwaysAllowThrottle },
    { provide: KILL_SWITCH, useClass: NeverPausedKillSwitch },
    { provide: SEQUENCE_STEPS, useValue: DEFAULT_SEQUENCE_STEPS_MS },
    {
      provide: EMAIL_SEND_CONFIG,
      useFactory: (): EmailSendConfig => ({
        unsubscribeSecret: process.env.EMAIL_UNSUBSCRIBE_SECRET ?? requireDevSecret(),
        publicBaseUrl: process.env.API_PUBLIC_BASE_URL ?? 'http://localhost:3001',
      }),
    },
    {
      // BullMQ connection — matches `.env.example`'s REDIS_URL. Not the shared
      // throttle service (§3); this is only the queue's own Redis connection.
      provide: 'OUTREACH_EMAIL_REDIS_CONNECTION',
      useFactory: () => ({ url: process.env.REDIS_URL ?? 'redis://localhost:6380', maxRetriesPerRequest: null }),
    },
  ],
  exports: [OutreachEmailService, EmailSendService, SequenceService, OutreachEmailWebhookService, InboundEmailService],
})
export class OutreachEmailModule {}

function requireDevSecret(): string {
  if (process.env.ALLOW_DEV_SECRETS === '1') return 'dev-only-unsubscribe-secret-change-me-0000';
  throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not set (see .env.example / ALLOW_DEV_SECRETS).');
}
