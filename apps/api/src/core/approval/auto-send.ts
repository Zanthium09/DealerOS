/**
 * §9 — "configurable auto-send thresholds per module". Deterministic, not a model
 * decision (§1.5).
 *
 * A rule is per source module. A draft may skip the queue only if its largest money
 * value is at or below the rule's threshold. No rule for a module means everything
 * from that module needs a human — the safe default, and the reason the default
 * provider below is an empty list rather than something permissive.
 */
export type AutoSendRule = {
  /** Recorded on the draft (`autoSendRuleId`) and in the AuditEvent, so §9's
   *  "which rule triggered the auto-send" has an answer years later. */
  id: string;
  sourceModule: string;
  /** Largest money value in paise that may auto-send. 0 means "only drafts with no
   *  money in them at all" — which is §5.2 cold outreach, the one auto-send case
   *  CLAUDE.md names outright. */
  maxValuePaise: number;
};

export const AUTO_SEND_RULES = 'AUTO_SEND_RULES';

/** The rule that lets this draft skip the queue, or null if a human must see it. */
export function autoSendRuleFor(
  rules: readonly AutoSendRule[],
  sourceModule: string,
  maxMoneyPaise: number,
): AutoSendRule | null {
  return (
    rules.find((r) => r.sourceModule === sourceModule && maxMoneyPaise <= r.maxValuePaise) ?? null
  );
}
