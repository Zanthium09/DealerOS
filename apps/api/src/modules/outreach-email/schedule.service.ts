import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OutreachSchedule, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { SCHEDULE_QUEUE } from './schedule.tokens';
import type { OutreachSegmentFilter } from './eligibility';

export type ScheduleInput = {
  name: string;
  cronExpression: string;
  enabled?: boolean;
  maxDealersPerRun?: number | null;
  segmentFilter?: OutreachSegmentFilter;
};

/**
 * "Every possible way of sending" (the manual dashboard button, and this) share one
 * eligibility/drafting/send path — OutreachEmailService.runColdOutreach. A schedule is
 * only ever a durable instruction for WHEN and with WHAT FILTER to call that same
 * method; it is never a second implementation of what a cold-outreach run does.
 *
 * The repeatable job's data is just `{ scheduleId }` — the worker (schedule-queue.ts)
 * re-reads this row fresh every time it fires rather than freezing config into the
 * job at registration time, so editing maxDealersPerRun/segmentFilter/enabled takes
 * effect on the NEXT firing with no need to touch the BullMQ registration at all.
 * Only the cron expression itself requires re-registering, since that is the one
 * thing BullMQ's repeat scheduling actually holds onto.
 */
@Injectable()
export class ScheduleService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SCHEDULE_QUEUE) private readonly queue: Queue,
  ) {}

  list(): Promise<OutreachSchedule[]> {
    return this.prisma.outreachSchedule.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(userId: string, input: ScheduleInput): Promise<OutreachSchedule> {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    if (!input.cronExpression?.trim()) throw new BadRequestException('cronExpression is required');

    const row = await this.prisma.outreachSchedule.create({
      data: {
        organizationId: getOrgId()!,
        name: input.name.trim(),
        cronExpression: input.cronExpression.trim(),
        enabled: input.enabled ?? true,
        maxDealersPerRun: input.maxDealersPerRun ?? null,
        segmentFilter: (input.segmentFilter ?? {}) as object,
        createdByUserId: userId,
      },
    });

    if (row.enabled) {
      try {
        await this.register(row);
      } catch (err) {
        // A row with no matching job is worse than no row: reconcileSchedules() would
        // try (and fail) to register it on every future boot, and it would sit in the
        // list looking active while silently never firing. Roll it back so a rejected
        // create leaves nothing behind, same as the create never happened.
        await this.prisma.outreachSchedule.delete({ where: { id: row.id } });
        throw err;
      }
    }
    return row;
  }

  async update(id: string, input: Partial<ScheduleInput>): Promise<OutreachSchedule> {
    const existing = await this.load(id);
    const cronChanged = input.cronExpression !== undefined && input.cronExpression !== existing.cronExpression;
    const willBeEnabled = input.enabled ?? existing.enabled;
    const nowDisabled = existing.enabled && !willBeEnabled;
    const nowEnabled = !existing.enabled && willBeEnabled;

    // Validate the NEW cron against Redis before writing anything to Postgres — a
    // rejected update must leave the existing row exactly as it was, not a row
    // holding a cron expression no job was ever registered for (see create()'s same
    // reasoning). Register under the new id/pattern first; only unregister the old
    // one once the new one is confirmed to exist.
    if (willBeEnabled && (cronChanged || nowEnabled)) {
      await this.register({ ...existing, cronExpression: input.cronExpression?.trim() ?? existing.cronExpression });
    }
    if (existing.enabled && (cronChanged || nowDisabled)) {
      await this.unregister(existing);
    }

    return this.prisma.outreachSchedule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.cronExpression !== undefined ? { cronExpression: input.cronExpression.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.maxDealersPerRun !== undefined ? { maxDealersPerRun: input.maxDealersPerRun } : {}),
        ...(input.segmentFilter !== undefined ? { segmentFilter: input.segmentFilter as object } : {}),
      },
    });
  }

  async remove(id: string): Promise<void> {
    const existing = await this.load(id);
    await this.unregister(existing);
    await this.prisma.outreachSchedule.delete({ where: { id } });
  }

  private async load(id: string): Promise<OutreachSchedule> {
    const row = await this.prisma.outreachSchedule.findFirst({ where: { id } });
    if (!row) throw new BadRequestException(`no schedule ${id} in this organization`);
    return row;
  }

  private async register(row: OutreachSchedule): Promise<void> {
    try {
      await this.queue.add('run', { scheduleId: row.id }, { repeat: { pattern: row.cronExpression }, jobId: row.id });
    } catch (err) {
      throw new BadRequestException(
        `invalid cron expression "${row.cronExpression}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async unregister(row: OutreachSchedule): Promise<void> {
    await this.queue.removeRepeatable('run', { pattern: row.cronExpression }, row.id);
  }
}
