import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { ApprovalService } from './approval.service';
import { AUTO_SEND_RULES } from './auto-send';

/**
 * §9 — build early, build once.
 *
 * AUTO_SEND_RULES defaults to none, so out of the box every draft needs a human.
 * Adding a rule is a deliberate act by whoever wires the app; the failure mode of
 * forgetting to configure it is "a person has to click", not "it sent itself".
 */
@Module({
  imports: [AuditModule],
  providers: [ApprovalService, { provide: AUTO_SEND_RULES, useValue: [] }],
  exports: [ApprovalService, AUTO_SEND_RULES],
})
export class ApprovalModule {}
