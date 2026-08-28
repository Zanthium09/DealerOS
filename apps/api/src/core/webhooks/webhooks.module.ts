import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import type { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { PRISMA } from '../tenancy/tenancy.module';
import { closeSharedRedis, newRedisConnection, sharedRedis } from '../redis';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { createWebhookQueue, createWebhookWorker, WEBHOOK_QUEUE_NAME } from './webhook-queue';
import { hmacSha256Adapter, type WebhookAdapter } from './webhook-adapter';
import { ADAPTERS, WEBHOOK_QUEUE, WORKER, WORKER_REDIS, QUEUE_NAME } from './webhooks.tokens';

// Re-exported so existing `from './webhooks.module'` imports (this module's own tests
// included) keep working — see webhooks.tokens.ts for why the values live there now.
export { ADAPTERS, WEBHOOK_QUEUE, QUEUE_NAME };

/**
 * Default adapters. Real per-provider signature schemes (Meta's Cloud API for §7,
 * the email provider for §6) are registered here once M2/M3 exist to say what a
 * verified payload becomes as an InteractionEvent — that mapping needs the Dealer
 * lookup those modules own. What ships now is the generic scheme (webhook-adapter.ts)
 * plus a `test` adapter this module's own tests use to exercise the full pipeline
 * (idempotency, raw-body verification, queueing, InteractionEvent write) end to end
 * without depending on either of those modules.
 *
 * `test` is only ever registered outside production — it is not a real provider.
 */
function defaultAdapters(): Map<string, WebhookAdapter> {
  const adapters = new Map<string, WebhookAdapter>();
  if (process.env.NODE_ENV !== 'production') {
    adapters.set(
      'test',
      hmacSha256Adapter({
        secret: process.env.WEBHOOK_TEST_SECRET ?? 'test-webhook-secret-0123456789',
        signatureHeader: 'x-webhook-signature',
        signaturePrefix: 'sha256=',
      }),
    );
  }
  return adapters;
}

@Module({
  controllers: [WebhooksController],
  providers: [
    { provide: ADAPTERS, useFactory: defaultAdapters },
    // Overridable per-instance so more than one WebhooksModule can run against the
    // same real Redis without their Workers stealing each other's jobs (see
    // webhook-queue.ts) — defaulted from env rather than hardcoded so tests can set
    // it before the module compiles, with no change to production wiring.
    { provide: QUEUE_NAME, useFactory: () => process.env.WEBHOOK_QUEUE_NAME || WEBHOOK_QUEUE_NAME },
    {
      provide: WEBHOOK_QUEUE,
      useFactory: (queueName: string) => createWebhookQueue(sharedRedis(), queueName),
      inject: [QUEUE_NAME],
    },
    { provide: WORKER_REDIS, useFactory: () => newRedisConnection() },
    {
      provide: WORKER,
      useFactory: (
        prisma: PrismaClient,
        adapters: Map<string, WebhookAdapter>,
        connection: ReturnType<typeof newRedisConnection>,
        queueName: string,
      ) => createWebhookWorker(connection, prisma, adapters, queueName),
      inject: [PRISMA, ADAPTERS, WORKER_REDIS, QUEUE_NAME],
    },
    WebhooksService,
  ],
  exports: [WebhooksService, ADAPTERS, WEBHOOK_QUEUE],
})
export class WebhooksModule implements OnModuleDestroy {
  constructor(
    @Inject(WORKER) private readonly worker: Worker,
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
    @Inject(WORKER_REDIS) private readonly workerRedis: IORedis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    // BullMQ does not close a Queue/Worker's Redis connection when it was supplied
    // rather than created internally — each connection here is closed explicitly.
    await this.queue.close();
    closeSharedRedis();
    this.workerRedis.disconnect();
  }
}
