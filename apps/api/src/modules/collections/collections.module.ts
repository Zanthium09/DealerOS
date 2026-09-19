import { Inject, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConnectionOptions } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { ApprovalModule } from '../../core/approval';
import { AuditModule } from '../../core/audit';
import { DraftingModule } from '../../core/drafting';
import { startDailyOrgJob } from '../../core/scheduling/daily-org-job';
import { OutreachEmailModule } from '../outreach-email/outreach-email.module';
import { SyncModule } from '../sync';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';

const CONNECTION = 'COLLECTIONS_REDIS_CONNECTION';

/** M7 (§5.8). Daily at 03:15 IST, after the dormancy scan, for every org that switched it on. */
@Module({
  imports: [AuditModule, ApprovalModule, DraftingModule, OutreachEmailModule, SyncModule],
  controllers: [CollectionsController],
  providers: [
    CollectionsService,
    { provide: CONNECTION, useFactory: (): ConnectionOptions => ({ url: process.env.REDIS_URL ?? 'redis://localhost:6380', maxRetriesPerRequest: null }) },
  ],
  exports: [CollectionsService],
})
export class CollectionsModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly rawPrisma = new PrismaClient();
  private job?: { stop: () => Promise<void> };

  constructor(
    private readonly collections: CollectionsService,
    @Inject(CONNECTION) private readonly connection: ConnectionOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.job = startDailyOrgJob({
      name: 'collections-run',
      pattern: '15 3 * * *',
      connection: this.connection,
      listOrgIds: async () => (await this.rawPrisma.collectionsSettings.findMany({ where: { enabled: true }, select: { organizationId: true } })).map((r) => r.organizationId),
      run: () => this.collections.run(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.job?.stop();
    await this.rawPrisma.$disconnect();
  }
}
