import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { DraftingService } from './drafting.service';

// §1.4 / §1.5 — the AI output boundary. ApprovalModule is imported for AUTO_SEND_RULES
// only: whether a draft may skip the queue is the approval queue's rule to own, not a
// second copy of the same threshold living here (§9, "build once").
@Module({
  imports: [ApprovalModule],
  providers: [DraftingService],
  exports: [DraftingService],
})
export class DraftingModule {}
