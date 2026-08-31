import { ConnectionOptions, Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { runWithOrg } from '../../core/tenancy/tenancy';
import type { OutreachEmailService } from './outreach-email.service';
import { SCHEDULE_QUEUE_NAME } from './schedule.tokens';

// Same 'OUTREACH_EMAIL_REDIS_CONNECTION' config sequence.service.ts already uses —
// one connection config for this module's queues, not a second one reinvented here.
export function createScheduleQueue(connection: ConnectionOptions, queueName = SCHEDULE_QUEUE_NAME): Queue {
  return new Queue(queueName, { connection });
}

/**
 * The worker fires with no org context — it only has a scheduleId (schedule.service.ts's
 * class doc explains why config isn't frozen into the job). Reading the schedule row to
 * even LEARN which org it belongs to therefore needs a client with no org context yet,
 * which is exactly the situation AuthModule/PlatformAdminModule are already in for
 * their first query of a login (see their module comments) — same precedent, same
 * reason: an org-scoped client cannot answer "which org is this" before it has one.
 * Everything after that first read runs inside runWithOrg with the real, scoped
 * OutreachEmailService.
 */
export function createScheduleWorker(
  connection: ConnectionOptions,
  rawPrisma: PrismaClient,
  outreach: OutreachEmailService,
  queueName = SCHEDULE_QUEUE_NAME,
): Worker {
  return new Worker(
    queueName,
    async (job) => {
      const scheduleId = job.data.scheduleId as string;
      const row = await rawPrisma.outreachSchedule.findUnique({ where: { id: scheduleId } });
      if (!row || !row.enabled) return; // deleted or disabled since this firing was queued

      await runWithOrg(row.organizationId, async () => {
        await outreach.runColdOutreach(row.organizationId, {
          maxDealers: row.maxDealersPerRun ?? undefined,
          segmentFilter: (row.segmentFilter ?? {}) as never,
        });
        await rawPrisma.outreachSchedule.update({ where: { id: row.id }, data: { lastRunAt: new Date() } });
      });
    },
    { connection },
  );
}

/**
 * Boot-time reconciliation: BullMQ's repeatable-job registry lives in Redis, not
 * Postgres, so it does not survive a Redis flush, and a fresh environment has never
 * registered anything at all. Re-adding every enabled schedule is idempotent — same
 * jobId + pattern is a no-op, not a duplicate — so this is safe to run on every boot
 * rather than needing to detect "did this already happen".
 */
export async function reconcileSchedules(queue: Queue, rawPrisma: PrismaClient): Promise<void> {
  const enabled = await rawPrisma.outreachSchedule.findMany({ where: { enabled: true } });
  for (const row of enabled) {
    try {
      await queue.add('run', { scheduleId: row.id }, { repeat: { pattern: row.cronExpression }, jobId: row.id });
    } catch (err) {
      // One malformed row (schedule.service.ts's create/update now refuse to persist
      // one, but an old row or a hand-edited one is still possible) must not take
      // down boot for every organization's schedules behind it in the list.
      // eslint-disable-next-line no-console
      console.error(
        `outreach schedule ${row.id} ("${row.name}") failed to register at boot — ` +
          `${err instanceof Error ? err.message : String(err)}. Skipped, not fatal.`,
      );
    }
  }
}
