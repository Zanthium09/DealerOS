// §6 — "New identity → warmup ramp, ~20/day rising over 10-14 days. Hard cap 30-50
// per identity per day during and shortly after warmup." Pure function: no I/O, easy
// to hit every day of the ramp in a test.
const RAMP_START = 20;
const RAMP_DAYS = 14;
const HARD_CAP = 50;
// "shortly after" — grace window where the hard cap still applies even though the
// ramp itself has topped out, before whatever steady-state limit the org sets takes over.
const HARD_CAP_GRACE_DAYS = 14;

/** The ramp value for a given day of warmup. Day 0 = the day warmup started. */
export function warmupRampLimit(daysSinceStart: number): number {
  if (daysSinceStart <= 0) return RAMP_START;
  if (daysSinceStart >= RAMP_DAYS) return HARD_CAP;
  const grown = RAMP_START + (HARD_CAP - RAMP_START) * (daysSinceStart / RAMP_DAYS);
  return Math.min(HARD_CAP, Math.round(grown));
}

/**
 * The limit actually in force for an identity today: during warmup and the grace
 * window after it, the ramp/hard-cap wins even over a larger `currentDailyLimit` an
 * org might have set; once fully past that window, `currentDailyLimit` governs.
 */
export function effectiveDailyLimit(params: {
  currentDailyLimit: number;
  warmupStartedAt: Date | null;
  now?: Date;
}): number {
  const { currentDailyLimit, warmupStartedAt, now = new Date() } = params;
  if (!warmupStartedAt) return currentDailyLimit;

  const daysSinceStart = Math.floor(
    (now.getTime() - warmupStartedAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (daysSinceStart < 0) return Math.min(currentDailyLimit, RAMP_START);
  if (daysSinceStart <= RAMP_DAYS + HARD_CAP_GRACE_DAYS) {
    return Math.min(currentDailyLimit, warmupRampLimit(daysSinceStart), HARD_CAP);
  }
  return currentDailyLimit;
}
