import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit';
import { OutreachWhatsAppModule } from '../outreach-whatsapp';
import { OrderingBotController } from './ordering-bot.controller';
import { OrderingBotService } from './ordering-bot.service';

// M8 (§5.9). Imports the WhatsApp module for InboundBotRegistry and the guarded sender;
// that module never imports this one — the bot plugs in, it is not depended on.
@Module({
  imports: [AuditModule, OutreachWhatsAppModule],
  controllers: [OrderingBotController],
  providers: [OrderingBotService],
})
export class OrderingBotModule {}
