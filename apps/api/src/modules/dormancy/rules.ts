// §5.6 — dormancy is arithmetic on dates and money, not a model's judgement (§1.5). Pure
// functions, so the boundaries are tested exactly.
export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSince(date: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}

/**
 * "No order in N days." A dealer whose last order was exactly N days ago has had no order
 * in N days, so the boundary is inclusive: N days of silence is dormant, N−1 is not.
 */
export function isDormant(lastOrder: Date, thresholdDays: number, now: Date = new Date()): boolean {
  return daysSince(lastOrder, now) >= thresholdDays;
}

export function averageOrderValue(total: number, count: number): number | null {
  return count > 0 ? Math.round((total / count) * 100) / 100 : null;
}

/**
 * §5.6 — "approval set by a configurable value threshold (below: auto-send; above:
 * approval queue)". With no threshold configured, or no order history to measure a dealer
 * by, nothing auto-sends: the safe default is a person looking first.
 */
export function autoSendEligible(aov: number | null, belowAov: number | null): boolean {
  return belowAov !== null && aov !== null && aov < belowAov;
}

/**
 * Did our nudge plausibly bring this order in? Only if a nudge went out BEFORE the order
 * and within the attribution window. An order that predates the nudge, or comes long
 * after it, is not credited to it (§15 — the case study must not over-claim).
 */
export function attributedToNudge(orderDate: Date, nudgeSentAt: Date | null, windowDays: number): boolean {
  if (!nudgeSentAt || orderDate < nudgeSentAt) return false;
  return orderDate.getTime() - nudgeSentAt.getTime() <= windowDays * DAY_MS;
}

export const NUDGE_QUIET_DAYS = 30;
/** Never re-nudge the same dealer inside this window, however often the scan runs. */
export function nudgedRecently(lastNudge: Date | null, now: Date = new Date()): boolean {
  return !!lastNudge && now.getTime() - lastNudge.getTime() < NUDGE_QUIET_DAYS * DAY_MS;
}
