import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PlatformAdminAuthController } from './platform-admin-auth.controller';
import { PlatformAdminAuthService } from './platform-admin-auth.service';
import { PlatformAdminGuard } from './platform-admin.guard';

// A bare PrismaClient for the same reason as core/auth: this flow authenticates
// before any context exists, and AdminUser is exempt from tenancy anyway (§9A).
//
// This module imports nothing from core/auth and core/auth imports nothing from
// here. That is the §9A.2 requirement, and it is checkable: a dependency-cruiser
// rule or a grep in CI will catch anyone who breaks it.
@Module({
  controllers: [PlatformAdminAuthController],
  providers: [
    PlatformAdminAuthService,
    PlatformAdminGuard,
    { provide: PrismaClient, useFactory: () => new PrismaClient() },
  ],
  exports: [PlatformAdminAuthService, PlatformAdminGuard],
})
export class PlatformAdminModule {}
