/**
 * §9 — "configurable auto-send thresholds per module". Deterministic, not a model
 * decision (§1.5).
 *
 * A rule is per source module, and it says one thing: this module's drafts may skip
 * the queue *when they carry no financial term at all*. There is no money threshold,
 * deliberately — §5.7 makes a scheme term a financial commitment, and a discount or a
 * free-goods quantity is one whether or not any rupee figure appears beside it. A
 * threshold expressed in paise cannot see those, so it read "40% off" as ₹0 and let it
 * auto-send. The one auto-send case CLAUDE.md names outright is §5.2 cold outreach,
 * which carries no financial terms by definition.
 *
 * No rule for a module means everything from that module needs a human — the safe
 * default, and the reason the default provider is an empty list rather than something
 * permissive.
 */
export type AutoSendRule = {
  /** Recorded on the draft (`autoSendRuleId`) and in the AuditEvent, so §9's
   *  "which rule triggered the auto-send" has an answer years later. */
  id: string;
  sourceModule: string;
};

export const AUTO_SEND_RULES = 'AUTO_SEND_RULES';

/** The rule that lets this module skip the queue, or null if a human must see it.
 *  Whether the draft itself is eligible is the caller's other half of the decision —
 *  drafting.service.ts asks only for drafts with no financial term in them. */
export function autoSendRuleFor(
  rules: readonly AutoSendRule[],
  sourceModule: string,
): AutoSendRule | null {
  return rules.find((r) => r.sourceModule === sourceModule) ?? null;
}
