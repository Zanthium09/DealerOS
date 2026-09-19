import { Inject, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { AuditModule } from '../../core/audit';
import { DraftingModule } from '../../core/drafting';
import { logRedisErrors } from '../../core/redis';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { OutreachEmailModule } from '../outreach-email/outreach-email.module';
import { DormancyController } from './dormancy.controller';
import { DormancyService } from './dormancy.service';

const QUEUE = 'dormancy-scan';
const CONNECTION = 'DORMANCY_REDIS_CONNECTION';

/**
 * M5 (§5.6). The scan runs once a day for every organization that has switched dormancy
 * on. A repeatable BullMQ job is registered idempotently at boot (same jobId + pattern is
 * a no-op, not a duplicate), and the worker learns WHICH orgs to scan from an unscoped
 * client — the same "which org is this, before I have one" situation the email schedule
 * worker is in — then runs each inside runWithOrg with the real, tenant-scoped service.
 * One org's failure is logged and does not stop the rest.
 */
@Module({
  imports: [AuditModule, DraftingModule, OutreachEmailModule],
  controllers: [DormancyController],
  providers: [
    DormancyService,
    { provide: CONNECTION, useFactory: (): ConnectionOptions => ({ url: process.env.REDIS_URL ?? 'redis://localhost:6380', maxRetriesPerRequest: null }) },
  ],
  exports: [DormancyService],
})
export class DormancyModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DormancyModule.name);
  private readonly rawPrisma = new PrismaClient();
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly dormancy: DormancyService,
    @Inject(CONNECTION) private readonly connection: ConnectionOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(QUEUE, { connection: this.connection });
    logRedisErrors(this.queue, `dormancy:${QUEUE}:queue`);
    // 02:30 IST — after the day's exports have typically been imported, before staff are in.
    await this.queue.add('scan', {}, { repeat: { pattern: '30 2 * * *', tz: 'Asia/Kolkata' }, jobId: 'dormancy-daily' });

    this.worker = new Worker(
      QUEUE,
      async () => {
        const orgs = await this.rawPrisma.dormancySettings.findMany({ where: { enabled: true }, select: { organizationId: true } });
        for (const { organizationId } of orgs) {
          try {
            const r = await runWithOrg(organizationId, () => this.dormancy.scan());
            this.logger.log(`dormancy scan ${organizationId}: +${r.activated} active, ${r.wentDormant.length} dormant, ${r.reactivated.length} reactivated`);
          } catch (err) {
            this.logger.error(`dormancy scan ${organizationId} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      },
      { connection: this.connection },
    );
    logRedisErrors(this.worker, `dormancy:${QUEUE}:worker`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.rawPrisma.$disconnect();
  }
}
