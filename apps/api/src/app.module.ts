import { Controller, Get, Module } from '@nestjs/common';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { AuditModule } from './core/audit';
import { AuthModule } from './core/auth';
import { PlatformAdminModule } from './core/platform-admin';
import { AiModule } from './providers/ai';
import { DraftingModule } from './core/drafting';
import { ApprovalModule } from './core/approval';
import { ContactsModule } from './modules/contacts';

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
    // that sends, so no module invents its own approval screen (§9).
    AiModule,
    DraftingModule,
    ApprovalModule,
    // M1 (§5.1). M0 will call its dedup service rather than reimplementing it.
    ContactsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
