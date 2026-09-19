import { Inject, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConnectionOptions } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { ApprovalModule } from '../../core/approval';
import { AuditModule } from '../../core/audit';
import { DraftingModule } from '../../core/drafting';
import { startDailyOrgJob } from '../../core/scheduling/daily-org-job';
import { OutreachEmailModule } from '../outreach-email/outreach-email.module';
import { SchemesController } from './schemes.controller';
import { SchemesService } from './schemes.service';

const CONNECTION = 'SCHEMES_REDIS_CONNECTION';

/**
 * M6 (§5.7). Attribution runs daily at 03:45 IST for every org that has a live or finished
 * scheme — after the night's order imports — so the uplift figures stay current without
 * anyone pressing a button. Announcements are never scheduled: a person starts them.
 */
@Module({
  imports: [AuditModule, ApprovalModule, DraftingModule, OutreachEmailModule],
  controllers: [SchemesController],
  providers: [
    SchemesService,
    { provide: CONNECTION, useFactory: (): ConnectionOptions => ({ url: process.env.REDIS_URL ?? 'redis://localhost:6380', maxRetriesPerRequest: null }) },
  ],
  exports: [SchemesService],
})
export class SchemesModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly rawPrisma = new PrismaClient();
  private job?: { stop: () => Promise<void> };

  constructor(
    private readonly schemes: SchemesService,
    @Inject(CONNECTION) private readonly connection: ConnectionOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.job = startDailyOrgJob({
      name: 'schemes-attribution',
      pattern: '45 3 * * *',
      connection: this.connection,
      listOrgIds: async () => (await this.rawPrisma.scheme.findMany({ where: { status: { in: ['ACTIVE', 'ENDED'] } }, select: { organizationId: true }, distinct: ['organizationId'] })).map((r) => r.organizationId),
      run: () => this.schemes.attribute(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.job?.stop();
    await this.rawPrisma.$disconnect();
  }
}
