import { DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { ApprovalService } from './approval.service';
import { AUTO_SEND_RULES, AutoSendRule } from './auto-send';

/**
 * §9 — build early, build once.
 *
 * AUTO_SEND_RULES defaults to none, so out of the box every draft needs a human.
 * Adding a rule is a deliberate act by whoever wires the app: AppModule calls
 * ApprovalModule.forRoot(rules) exactly once, and that registration is marked
 * `global: true` so every other module (DraftingModule, OutreachEmailModule, and
 * anything later) sees the SAME ApprovalService / AUTO_SEND_RULES instance without
 * listing ApprovalModule in its own `imports`.
 *
 * That `global: true` is load-bearing, not decoration: Nest treats a plain
 * `imports: [ApprovalModule]` (the non-forRoot form below) as registering a SEPARATE
 * module instance with its own empty-array AUTO_SEND_RULES — it does not merge with
 * whatever AppModule configured. Two modules each doing `imports: [ApprovalModule]`
 * silently got their own private "nothing auto-sends" copy, while AppModule's
 * configured rule sat in a third instance nothing downstream ever saw. Confirmed by
 * booting the real app and reading back the actual bound value from each service —
 * a bug of exactly this shape shipped once already this phase. Do not add
 * `imports: [ApprovalModule]` anywhere else; the global registration is enough.
 *
 * The plain `@Module()` below (empty rules, not global) exists only so a test can
 * import ApprovalModule in isolation without booting AppModule.
 */
@Module({
  imports: [AuditModule],
  providers: [ApprovalService, { provide: AUTO_SEND_RULES, useValue: [] }],
  exports: [ApprovalService, AUTO_SEND_RULES],
})
export class ApprovalModule {
  static forRoot(rules: readonly AutoSendRule[]): DynamicModule {
    return {
      global: true,
      module: ApprovalModule,
      imports: [AuditModule],
      providers: [ApprovalService, { provide: AUTO_SEND_RULES, useValue: rules }],
      exports: [ApprovalService, AUTO_SEND_RULES],
    };
  }
}
