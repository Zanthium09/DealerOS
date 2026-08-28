import { DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { ApprovalService } from './approval.service';
import { AUTO_SEND_RULES, AutoSendRule } from './auto-send';

/**
 * §9 — build early, build once.
 *
 * AUTO_SEND_RULES defaults to none, so out of the box every draft needs a human.
 * Adding a rule is a deliberate act by whoever wires the app (AppModule.forRoot, or
 * plain `imports: [ApprovalModule]` for the safe empty default) — the failure mode of
 * forgetting to configure it is "a person has to click", not "it sent itself".
 *
 * A plain provider here is not enough for a real app to override: Nest resolves a
 * token from the module that declares the consumer, not from whatever the root module
 * happens to also provide. forRoot() is the standard way to make that configurable.
 */
@Module({
  imports: [AuditModule],
  providers: [ApprovalService, { provide: AUTO_SEND_RULES, useValue: [] }],
  exports: [ApprovalService, AUTO_SEND_RULES],
})
export class ApprovalModule {
  static forRoot(rules: readonly AutoSendRule[]): DynamicModule {
    return {
      module: ApprovalModule,
      imports: [AuditModule],
      providers: [ApprovalService, { provide: AUTO_SEND_RULES, useValue: rules }],
      exports: [ApprovalService, AUTO_SEND_RULES],
    };
  }
}
