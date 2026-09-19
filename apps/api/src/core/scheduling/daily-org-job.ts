import { Logger } from '@nestjs/common';
import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { logRedisErrors } from '../redis';
import { runWithOrg } from '../tenancy/tenancy';

/**
 * A repeating job that does one thing for every organization that has switched a module
 * on — the shape M5 (dormancy) and M7 (collections) both need.
 *
 * The repeatable job is registered idempotently at boot (same jobId + pattern is a no-op,
 * not a duplicate, and survives a Redis flush because boot re-adds it). The worker learns
 * WHICH orgs to visit from `listOrgIds`, which reads through an unscoped client — the same
 * "which org is this, before I have one" situation the email schedule worker is in — and
 * then runs each inside runWithOrg with the real, tenant-scoped service. One org's failure
 * is logged and never stops the rest.
 */
export function startDailyOrgJob(opts: {
  name: string;
  /** cron, evaluated in `tz`. */
  pattern: string;
  tz?: string;
  connection: ConnectionOptions;
  listOrgIds: () => Promise<string[]>;
  run: (organizationId: string) => Promise<unknown>;
}): { stop: () => Promise<void> } {
  const logger = new Logger(`job:${opts.name}`);
  const queue = new Queue(opts.name, { connection: opts.connection });
  logRedisErrors(queue, `${opts.name}:queue`);
  // Not awaited: registration failing (Redis down at boot) must not stop the API starting.
  void queue
    .add('run', {}, { repeat: { pattern: opts.pattern, tz: opts.tz ?? 'Asia/Kolkata' }, jobId: `${opts.name}-daily` })
    .catch((err) => logger.error(`could not register the repeatable job: ${err instanceof Error ? err.message : err}`));

  const worker = new Worker(
    opts.name,
    async () => {
      for (const organizationId of await opts.listOrgIds()) {
        try {
          await runWithOrg(organizationId, () => opts.run(organizationId));
          logger.log(`done for ${organizationId}`);
        } catch (err) {
          logger.error(`failed for ${organizationId}: ${err instanceof Error ? err.message : err}`);
        }
      }
    },
    { connection: opts.connection },
  );
  logRedisErrors(worker, `${opts.name}:worker`);

  return {
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
