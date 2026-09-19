import type { AgeingBucket } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from due date to `now`. Negative = not yet due. */
export function daysOverdue(dueDate: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
}

/**
 * §5.8 — the bucket is derived from days overdue, never hand-set, so it cannot drift
 * from the dates it summarises. The names are read literally: D30 is "30 days late",
 * D60 "60 days late", D90_PLUS "90 or more". CURRENT is everything under 30 days
 * late, including not-yet-due and fully paid.
 *
 * (An accounting system may bucket 1-30 / 31-60 / 61-90 instead. §16.1 leaves the
 * accounting system open — change the thresholds here and nowhere else.)
 */
export function ageingBucketFor(
  entry: { dueDate: Date; amount: number; paidAmount: number },
  now: Date = new Date(),
): AgeingBucket {
  if (entry.paidAmount >= entry.amount) return 'CURRENT';
  const late = daysOverdue(entry.dueDate, now);
  if (late >= 90) return 'D90_PLUS';
  if (late >= 60) return 'D60';
  if (late >= 30) return 'D30';
  return 'CURRENT';
}
