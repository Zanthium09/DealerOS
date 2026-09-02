import { Module, OnApplicationBootstrap, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { AuditModule } from '../../core/audit';
import { KillSwitchModule } from '../../core/killswitch';
import { DraftingModule } from '../../core/drafting';
import { AiModule } from '../../providers/ai';
import { EmailModule } from '../../providers/email';
import { OutreachEmailController } from './outreach-email.controller';
import { OutreachEmailDashboardController } from './dashboard.controller';
import { ScheduleController } from './schedule.controller';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { CustomDraftService } from './custom-draft.service';
import { SuppressionController } from './suppression.controller';
import { OutreachEmailService } from './outreach-email.service';
import { ColdDraftService } from './cold-draft.service';
import { EmailSendService, EMAIL_SEND_CONFIG, EmailSendConfig } from './send.service';
import { SequenceService, SEQUENCE_STEPS, DEFAULT_SEQUENCE_STEPS_MS } from './sequence.service';
import { OutreachEmailWebhookService } from './webhook.service';
import { InboundEmailService } from './inbound.service';
import { ResendInboundWebhookService } from './inbound-webhook.service';
import { UnsubscribeEndpointService } from './unsubscribe-endpoint.service';
import { KILL_SWITCH, SEND_THROTTLE } from './ports';
import { OutreachSettingsService } from './settings.service';
import { EmailKillSwitch, EmailSendThrottle } from './throttle.impl';
import { ScheduleService } from './schedule.service';
import { createScheduleQueue, createScheduleWorker, reconcileSchedules } from './schedule-queue';
import { SCHEDULE_QUEUE, SCHEDULE_QUEUE_NAME } from './schedule.tokens';

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
  imports: [AuditModule, DraftingModule, AiModule, EmailModule, KillSwitchModule],
  controllers: [
    OutreachEmailController,
    OutreachEmailDashboardController,
    ScheduleController,
    TemplateController,
    SuppressionController,
  ],
  providers: [
    OutreachEmailService,
    ColdDraftService,
    TemplateService,
    CustomDraftService,
    EmailSendService,
    SequenceService,
    OutreachEmailWebhookService,
    InboundEmailService,
    ResendInboundWebhookService,
    UnsubscribeEndpointService,
    ScheduleService,
    OutreachSettingsService,
    EmailSendThrottle,
    EmailKillSwitch,
    // The real implementations. These two ports were still bound to
    // AlwaysAllowThrottle / NeverPausedKillSwitch — placeholders from before
    // core/throttle and core/killswitch existed — which meant that in production
    // neither the throttle nor the kill switch did anything at all.
    { provide: SEND_THROTTLE, useExisting: EmailSendThrottle },
    { provide: KILL_SWITCH, useExisting: EmailKillSwitch },
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
    {
      provide: SCHEDULE_QUEUE,
      useFactory: (connection: ConnectionOptions) => createScheduleQueue(connection),
      inject: ['OUTREACH_EMAIL_REDIS_CONNECTION'],
    },
  ],
  exports: [OutreachEmailService, EmailSendService, SequenceService, OutreachEmailWebhookService, InboundEmailService],
})
export class OutreachEmailModule implements OnApplicationBootstrap, OnModuleDestroy {
  // A dedicated, UNSCOPED client — not the tenancy-scoped PRISMA token. The worker
  // learns which org a firing belongs to by reading the schedule row itself, so it
  // cannot start inside an org context it doesn't have yet. Same precedent as
  // AuthModule/PlatformAdminModule's bare client for the first query of a login.
  private readonly rawPrisma = new PrismaClient();
  private worker?: Worker;

  constructor(
    @Inject(SCHEDULE_QUEUE) private readonly scheduleQueue: Queue,
    private readonly outreach: OutreachEmailService,
    @Inject('OUTREACH_EMAIL_REDIS_CONNECTION') private readonly redisConnection: ConnectionOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.worker = createScheduleWorker(this.redisConnection, this.rawPrisma, this.outreach, SCHEDULE_QUEUE_NAME);
    await reconcileSchedules(this.scheduleQueue, this.rawPrisma);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.scheduleQueue.close();
    await this.rawPrisma.$disconnect();
  }
}

function requireDevSecret(): string {
  if (process.env.ALLOW_DEV_SECRETS === '1') return 'dev-only-unsubscribe-secret-change-me-0000';
  throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not set (see .env.example / ALLOW_DEV_SECRETS).');
}
