// §5.8 — the escalation ladder is a deterministic state machine driven by days overdue
// (§1.5). Pure functions, so every threshold and boundary is tested exactly.
import type { EscalationLevel } from '@prisma/client';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export type Thresholds = { gentleAfterDays: number; firmAfterDays: number; humanAfterDays: number };

/** null = valid, else why not. Rungs must be positive and strictly increasing — a ladder
 *  where "firm" starts before "gentle" would send the harsher message first. */
export function validateThresholds(t: Thresholds): string | null {
  for (const [k, v] of Object.entries(t)) {
    if (!Number.isInteger(v) || v < 1) return `${k} must be a whole number of days, at least 1`;
  }
  if (!(t.gentleAfterDays < t.firmAfterDays && t.firmAfterDays < t.humanAfterDays)) {
    return 'the rungs must increase: gentle, then firm, then a person’s call';
  }
  return null;
}

/** Which rung a dealer is on, from how long their OLDEST unpaid invoice has been overdue.
 *  Boundaries are inclusive: exactly `firmAfterDays` late is firm. */
export function levelFor(oldestDaysOverdue: number, t: Thresholds): EscalationLevel {
  if (oldestDaysOverdue >= t.humanAfterDays) return 'HUMAN';
  if (oldestDaysOverdue >= t.firmAfterDays) return 'FIRM';
  if (oldestDaysOverdue >= t.gentleAfterDays) return 'GENTLE';
  return 'NONE';
}

const RANK: Record<EscalationLevel, number> = { NONE: 0, GENTLE: 1, FIRM: 2, HUMAN: 3 };
export const rankOf = (l: EscalationLevel | null | undefined) => RANK[l ?? 'NONE'];

/**
 * A written reminder is due when the dealer is on the gentle or firm rung AND either has
 * never been reminded, has just moved up a rung (an escalation is not held back by the
 * interval), or the interval since the last reminder has passed. The HUMAN rung is never
 * a written reminder — the final escalation is a person's call and is never automated.
 */
export function shouldRemind(s: {
  level: EscalationLevel;
  lastReminderAt: Date | null;
  lastReminderLevel: EscalationLevel | null;
  intervalDays: number;
  now: Date;
}): boolean {
  if (s.level !== 'GENTLE' && s.level !== 'FIRM') return false;
  if (!s.lastReminderAt) return true;
  if (rankOf(s.level) > rankOf(s.lastReminderLevel)) return true;
  return s.now.getTime() - s.lastReminderAt.getTime() >= s.intervalDays * DAY_MS;
}

/** A person should call — and having just reached them, we wait out the interval before
 *  raising it again rather than nagging the caller about a dealer they spoke to today. */
export function callDue(s: { level: EscalationLevel; handledAt: Date | null; intervalDays: number; now: Date }): boolean {
  if (s.level !== 'HUMAN') return false;
  return !s.handledAt || s.now.getTime() - s.handledAt.getTime() >= s.intervalDays * DAY_MS;
}

/**
 * §10.4 — "stale payment data → refuse to send". A ledger line is only chased if it was
 * seen by a sync inside the freshness window: a line the latest export no longer contains
 * (paid, credited, cancelled) keeps its old lastSyncedAt and so stops being chased, rather
 * than producing a demand for money that may no longer be owed.
 */
export function isFresh(lastSyncedAt: Date | null | undefined, windowHours: number, now: Date): boolean {
  return !!lastSyncedAt && now.getTime() - lastSyncedAt.getTime() <= windowHours * HOUR_MS;
}

/** Whole paise for the drafting service, which refuses floats (§1.4). */
export const toPaise = (rupees: number) => Math.round(rupees * 100);
export const daysOverdue = (dueDate: Date, now: Date) => Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
