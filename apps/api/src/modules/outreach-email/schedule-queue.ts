import { ConnectionOptions, Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { runWithOrg } from '../../core/tenancy/tenancy';
import { logRedisErrors } from '../../core/redis';
import type { OutreachEmailService } from './outreach-email.service';
import { SCHEDULE_QUEUE_NAME } from './schedule.tokens';

// Same 'OUTREACH_EMAIL_REDIS_CONNECTION' config sequence.service.ts already uses —
// one connection config for this module's queues, not a second one reinvented here.
export function createScheduleQueue(connection: ConnectionOptions, queueName = SCHEDULE_QUEUE_NAME): Queue {
  const queue = new Queue(queueName, { connection });
  logRedisErrors(queue, `outreach-email:${queueName}:queue`);
  return queue;
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
  const worker = new Worker(
    queueName,
    async (job) => {
      const scheduleId = job.data.scheduleId as string;
      const row = await rawPrisma.outreachSchedule.findUnique({ where: { id: scheduleId } });
      if (!row || !row.enabled) return; // deleted or disabled since this firing was queued

      // A one-time schedule (scheduledAt set, cronExpression null) gets exactly this
      // one attempt — BullMQ is not configured to retry it, so success or failure,
      // it is done after this and gets disabled either way. A recurring one stays
      // enabled regardless of outcome; the next cron tick tries again on its own.
      // lastRunAt/lastError are recorded on BOTH paths — recording only on success
      // is how a schedule that fired and failed ends up looking identical to one
      // that never fired at all, forever, since nothing else will ever retry it.
      try {
        await runWithOrg(row.organizationId, () =>
          outreach.runColdOutreach(row.organizationId, {
            maxDealers: row.maxDealersPerRun ?? undefined,
            segmentFilter: (row.segmentFilter ?? {}) as never,
          }),
        );
        await rawPrisma.outreachSchedule.update({
          where: { id: row.id },
          data: { lastRunAt: new Date(), lastError: null, ...(row.cronExpression ? {} : { enabled: false }) },
        });
      } catch (err) {
        await rawPrisma.outreachSchedule.update({
          where: { id: row.id },
          data: {
            lastRunAt: new Date(),
            lastError: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
            ...(row.cronExpression ? {} : { enabled: false }),
          },
        });
        throw err; // BullMQ's own bookkeeping (the failed set, retry policy) still applies
      }
    },
    { connection },
  );
  logRedisErrors(worker, `outreach-email:${queueName}:worker`);
  return worker;
}

/**
 * Boot-time reconciliation: BullMQ's repeatable-job registry lives in Redis, not
 * Postgres, so it does not survive a Redis flush, and a fresh environment has never
 * registered anything at all. Re-adding every enabled recurring schedule is
 * idempotent — same jobId + pattern is a no-op, not a duplicate.
 *
 * A one-time (scheduledAt) job is different: it is NOT repeatable, so re-adding one
 * that is still waiting would need to skip rather than duplicate (checked via
 * queue.getJob). And if its moment already passed while the process was down —
 * the whole point of "schedule this for later" is that it still happens even if
 * nobody was watching — it fires immediately (delay: 0) rather than being silently
 * dropped. It still goes through every guard runColdOutreach/EmailSendService
 * already enforce (approval, consent, kill switch, staging guard); it is only late.
 */
export async function reconcileSchedules(queue: Queue, rawPrisma: PrismaClient): Promise<void> {
  const enabled = await rawPrisma.outreachSchedule.findMany({ where: { enabled: true } });
  for (const row of enabled) {
    try {
      if (row.cronExpression) {
        await queue.add('run', { scheduleId: row.id }, { repeat: { pattern: row.cronExpression }, jobId: row.id });
      } else if (row.scheduledAt) {
        if (await queue.getJob(row.id)) continue; // already registered, still waiting
        const delay = Math.max(0, row.scheduledAt.getTime() - Date.now());
        await queue.add('run', { scheduleId: row.id }, { delay, jobId: row.id });
      }
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
