import { Module } from '@nestjs/common';
import { DraftingService } from './drafting.service';

// §1.4 / §1.5 — the AI output boundary. DraftingService injects AUTO_SEND_RULES, which
// AppModule's ApprovalModule.forRoot(...) registers globally (see approval.module.ts) —
// no import of ApprovalModule needed or wanted here. Adding one back creates a second,
// disconnected empty-rules instance; that exact bug shipped once already this phase.
@Module({
  providers: [DraftingService],
  exports: [DraftingService],
})
export class DraftingModule {}
