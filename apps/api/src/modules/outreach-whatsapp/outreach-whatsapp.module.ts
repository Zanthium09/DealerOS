import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit';
import { KillSwitchModule } from '../../core/killswitch';
import { OutreachEmailModule } from '../outreach-email/outreach-email.module';
import { WhatsAppDashboardController } from './whatsapp-dashboard.controller';
import { WhatsAppDraftService } from './whatsapp-draft.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WhatsAppSendService } from './whatsapp-send.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppTemplateService } from './template.service';

// M3 (§5.3). WHATSAPP_PROVIDER comes from the global WhatsAppProviderModule (imported in
// AppModule). OutreachEmailModule is imported for SequenceService — a WhatsApp reply
// halts the email follow-up sequence, and there must be one sequence implementation.
// ApprovalService is global (ApprovalModule.forRoot), not re-imported: importing the plain
// module again would create a second, empty-rules instance — the bug that shipped once.
@Module({
  imports: [AuditModule, KillSwitchModule, OutreachEmailModule],
  controllers: [WhatsAppWebhookController, WhatsAppDashboardController],
  providers: [WhatsAppTemplateService, WhatsAppSendService, WhatsAppDraftService, WhatsAppInboundService],
  exports: [WhatsAppSendService, WhatsAppTemplateService, WhatsAppDraftService],
})
export class OutreachWhatsAppModule {}
