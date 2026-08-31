import { Controller, Get, Module } from '@nestjs/common';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { AuditModule } from './core/audit';
import { AuthModule } from './core/auth';
import { PlatformAdminModule } from './core/platform-admin';
import { AiModule } from './providers/ai';
import { DraftingModule } from './core/drafting';
import { ApprovalModule } from './core/approval';
import { ContactsModule } from './modules/contacts';
import { ThrottleModule } from './core/throttle/throttle.module';
import { KillSwitchModule } from './core/killswitch/killswitch.module';
import { WebhooksModule } from './core/webhooks/webhooks.module';
import { EmailModule } from './providers/email/email.module';
import { OutreachEmailModule } from './modules/outreach-email/outreach-email.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SEND_THROTTLE, KILL_SWITCH } from './modules/outreach-email/ports';
import { SOURCE_MODULE as OUTREACH_EMAIL_SOURCE_MODULE } from './modules/outreach-email/send.service';
import { ThrottleServiceAdapter, KillSwitchAdapter } from './wiring/outreach-email-adapters';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}

// TenancyModule is first and @Global: it provides the scoped Prisma client and
// installs the middleware that puts every request in its org context (§1.3).
// AuthModule and PlatformAdminModule are two separate flows that share nothing but
// the database connection (§9A.2) — they are listed side by side here and nowhere
// else in the tree.
@Module({
  imports: [
    TenancyModule,
    AuditModule,
    AuthModule,
    PlatformAdminModule,
    // §11 step 2: drafting and the shared Approval Queue exist before any module
    // that sends, so no module invents its own approval screen (§9). §5.2: cold
    // outreach carries no financial terms by construction, so it is the one module
    // named outright as auto-send eligible — every other module gets no rule and
    // therefore needs a human, per forRoot()'s default when called with [].
    AiModule,
    DraftingModule,
    ApprovalModule.forRoot([{ id: 'cold-email-no-money', sourceModule: OUTREACH_EMAIL_SOURCE_MODULE }]),
    // M1 (§5.1). M0 will call its dedup service rather than reimplementing it.
    ContactsModule,
    // §11 step 3: InteractionEvent + webhook ingestion, throttle, kill switch — all
    // before an outreach module is more than blind one-way sending (§8, §12.6, §3).
    ThrottleModule,
    KillSwitchModule,
    WebhooksModule,
    // M2 (§5.2). Cold outreach carries no financial terms, so it is the one module
    // named outright as auto-send eligible (§9's default is otherwise empty).
    EmailModule,
    OutreachEmailModule,
    DashboardModule,
  ],
  controllers: [HealthController],
  providers: [
    // outreach-email codes against its own small SendThrottle/KillSwitch ports
    // (ports.ts) rather than importing core/throttle or core/killswitch directly —
    // this is where those ports get bound to the real services (see wiring/).
    { provide: SEND_THROTTLE, useClass: ThrottleServiceAdapter },
    { provide: KILL_SWITCH, useClass: KillSwitchAdapter },
  ],
})
export class AppModule {}
