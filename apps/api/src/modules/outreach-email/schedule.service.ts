import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OutreachSchedule, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { SCHEDULE_QUEUE } from './schedule.tokens';
import type { OutreachSegmentFilter } from './eligibility';

export type ScheduleInput = {
  name: string;
  /** Recurring — exactly one of cronExpression / scheduledAt, never both. */
  cronExpression?: string;
  /** One-time, at this exact moment. An ISO string or a Date; must be in the future
   *  at creation time (§ "select the date and time for a scheduled email"). */
  scheduledAt?: string | Date;
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
 * Two kinds, one table: `cronExpression` set = recurring (BullMQ repeatable job),
 * `scheduledAt` set = exactly once at that moment (BullMQ delayed job). A schedule's
 * kind cannot be changed by update() — switching from "every Monday" to "once, on the
 * 15th" is a different schedule, not an edit of one; delete and create instead. This
 * keeps register()/unregister() from needing to migrate a row between two BullMQ job
 * types mid-edit, which is exactly the kind of "looked like a small diff, was actually
 * a second bug" trap this codebase has hit before.
 *
 * The job's data is just `{ scheduleId }` — the worker (schedule-queue.ts) re-reads
 * this row fresh every time it fires rather than freezing config into the job at
 * registration time, so editing maxDealersPerRun/segmentFilter/enabled takes effect on
 * the NEXT firing with no need to touch the BullMQ registration at all. Only
 * cronExpression/scheduledAt themselves require re-registering, since those are the
 * one thing BullMQ's scheduling actually holds onto.
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
    const { cronExpression, scheduledAt } = this.normaliseTiming(input, true);

    const row = await this.prisma.outreachSchedule.create({
      data: {
        organizationId: getOrgId()!,
        name: input.name.trim(),
        cronExpression,
        scheduledAt,
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
    const isRecurring = existing.cronExpression !== null;

    if (isRecurring && input.scheduledAt !== undefined) {
      throw new BadRequestException('this schedule is recurring — delete and create a one-time schedule instead');
    }
    if (!isRecurring && input.cronExpression !== undefined) {
      throw new BadRequestException('this schedule is one-time — delete and create a recurring schedule instead');
    }

    const newCron = isRecurring ? (input.cronExpression?.trim() ?? existing.cronExpression!) : null;
    const newScheduledAt = !isRecurring
      ? input.scheduledAt !== undefined
        ? this.parseFutureDate(input.scheduledAt)
        : existing.scheduledAt!
      : null;
    const timingChanged = isRecurring
      ? newCron !== existing.cronExpression
      : newScheduledAt!.getTime() !== existing.scheduledAt!.getTime();

    const willBeEnabled = input.enabled ?? existing.enabled;
    const nowDisabled = existing.enabled && !willBeEnabled;
    const nowEnabled = !existing.enabled && willBeEnabled;

    // Validate the NEW timing against Redis before writing anything to Postgres — a
    // rejected update must leave the existing row exactly as it was. Register under
    // the (possibly new) timing first; only unregister the old one once the new one
    // is confirmed to exist, so there is never a gap where neither is registered.
    if (willBeEnabled && (timingChanged || nowEnabled)) {
      await this.register({ ...existing, cronExpression: newCron, scheduledAt: newScheduledAt });
    }
    if (existing.enabled && (timingChanged || nowDisabled)) {
      await this.unregister(existing);
    }

    return this.prisma.outreachSchedule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(isRecurring && input.cronExpression !== undefined ? { cronExpression: newCron } : {}),
        ...(!isRecurring && input.scheduledAt !== undefined ? { scheduledAt: newScheduledAt } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.maxDealersPerRun !== undefined ? { maxDealersPerRun: input.maxDealersPerRun } : {}),
        ...(input.segmentFilter !== undefined ? { segmentFilter: input.segmentFilter as object } : {}),
      },
    });
  }

  async remove(id: string): Promise<void> {
    const existing = await this.load(id);
    if (existing.enabled) await this.unregister(existing);
    await this.prisma.outreachSchedule.delete({ where: { id } });
  }

  private async load(id: string): Promise<OutreachSchedule> {
    const row = await this.prisma.outreachSchedule.findFirst({ where: { id } });
    if (!row) throw new BadRequestException(`no schedule ${id} in this organization`);
    return row;
  }

  /** Exactly one of cronExpression / scheduledAt, both trimmed/parsed and validated. */
  private normaliseTiming(
    input: Pick<ScheduleInput, 'cronExpression' | 'scheduledAt'>,
    requireOne: boolean,
  ): { cronExpression: string | null; scheduledAt: Date | null } {
    const hasCron = !!input.cronExpression?.trim();
    const hasScheduledAt = input.scheduledAt !== undefined && input.scheduledAt !== null;
    if (requireOne && !hasCron && !hasScheduledAt) {
      throw new BadRequestException('either cronExpression (recurring) or scheduledAt (one-time) is required');
    }
    if (hasCron && hasScheduledAt) {
      throw new BadRequestException('a schedule is either recurring (cronExpression) or one-time (scheduledAt), not both');
    }
    return {
      cronExpression: hasCron ? input.cronExpression!.trim() : null,
      scheduledAt: hasScheduledAt ? this.parseFutureDate(input.scheduledAt!) : null,
    };
  }

  private parseFutureDate(value: string | Date): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`"${value}" is not a valid date/time`);
    if (date.getTime() <= Date.now()) {
      throw new BadRequestException('scheduledAt must be in the future');
    }
    return date;
  }

  private async register(row: Pick<OutreachSchedule, 'id' | 'cronExpression' | 'scheduledAt'>): Promise<void> {
    try {
      if (row.cronExpression) {
        await this.queue.add('run', { scheduleId: row.id }, { repeat: { pattern: row.cronExpression }, jobId: row.id });
      } else {
        const delay = Math.max(0, row.scheduledAt!.getTime() - Date.now());
        await this.queue.add('run', { scheduleId: row.id }, { delay, jobId: row.id });
      }
    } catch (err) {
      const timing = row.cronExpression ? `cron expression "${row.cronExpression}"` : `date "${row.scheduledAt}"`;
      throw new BadRequestException(`invalid ${timing}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async unregister(row: Pick<OutreachSchedule, 'id' | 'cronExpression'>): Promise<void> {
    if (row.cronExpression) {
      await this.queue.removeRepeatable('run', { pattern: row.cronExpression }, row.id);
    } else {
      await this.queue.remove(row.id);
    }
  }
}
