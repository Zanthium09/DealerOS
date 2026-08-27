import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TenantAuthGuard } from './tenant-auth.guard';

// A bare PrismaClient, NOT the tenancy-scoped one, and deliberately so: login runs
// before any org context exists — it is the thing that establishes it — and the
// scoped client refuses every query outside a context (§1.3). The only query made
// here is User-by-email, which is why that is safe. Do not "fix" this by injecting
// PRISMA; you would break login, and the fix after that would be worse.
// The database connection is the one thing §9A.2 lets the two flows share.
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    TenantAuthGuard,
    { provide: PrismaClient, useFactory: () => new PrismaClient() },
  ],
  exports: [AuthService, TenantAuthGuard],
})
export class AuthModule {}
