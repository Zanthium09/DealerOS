import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { logRedisErrors } from '../redis';
import { processWebhookEvent } from './webhook-processor';
import type { WebhookAdapter } from './webhook-adapter';

export const WEBHOOK_QUEUE_NAME = 'webhook-processing';

export function createWebhookQueue(connection: IORedis, queueName = WEBHOOK_QUEUE_NAME): Queue {
  const queue = new Queue(queueName, { connection });
  logRedisErrors(queue, `webhooks:${queueName}:queue`);
  return queue;
}

/**
 * Its own dedicated Redis connection — a BullMQ Worker blocks on it, and sharing a
 * blocking connection with anything else (the Queue's `.add`, the throttle counters)
 * would stall those callers. §18 / §2: BullMQ + Redis, not a serverless function.
 *
 * `queueName` defaults to the one real production queue. Tests that boot more than
 * one WebhooksModule instance against the same real Redis (this module's own test
 * suite included — one app per describe block) must give each its own name, or their
 * Workers steal each other's jobs: same queue, same Redis, first Worker to poll wins,
 * regardless of which app's HTTP handler actually enqueued it.
 */
export function createWebhookWorker(
  connection: IORedis,
  prisma: PrismaClient,
  adapters: Map<string, WebhookAdapter>,
  queueName = WEBHOOK_QUEUE_NAME,
): Worker {
  const worker = new Worker(
    queueName,
    async (job) => {
      await processWebhookEvent(job.data.webhookEventId as string, prisma, adapters);
    },
    { connection },
  );
  logRedisErrors(worker, `webhooks:${queueName}:worker`);
  return worker;
}
