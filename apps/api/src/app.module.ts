import { Controller, Get, Module } from '@nestjs/common';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { AuditModule } from './core/audit';
import { AuthModule } from './core/auth';
import { PlatformAdminModule } from './core/platform-admin';

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
  imports: [TenancyModule, AuditModule, AuthModule, PlatformAdminModule],
  controllers: [HealthController],
})
export class AppModule {}
