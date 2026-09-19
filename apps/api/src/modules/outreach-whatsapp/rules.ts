// §5.3 / §7 — the WhatsApp rules, as pure functions so every branch is testable without a
// database or a Meta account. The services call these; nothing else decides them.
import type { ConsentState, ConversationState, PipelineStage } from '@prisma/client';

// ---- the 24-hour service window (§7) -----------------------------------------------

export const SESSION_MS = 24 * 60 * 60 * 1000;

/** The window opens (or renews) on the dealer's INBOUND message, not on ours. */
export const sessionExpiryFrom = (lastInbound: Date): Date => new Date(lastInbound.getTime() + SESSION_MS);

export function sessionOpen(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt.getTime() > now.getTime();
}

// ---- warm-routing (§1.2, §7) -------------------------------------------------------

/** Stages that mean the dealer is already in a relationship with us. */
export const WARM_STAGES: PipelineStage[] = ['INTERESTED', 'ONBOARDED', 'ACTIVE', 'DORMANT', 'REACTIVATED'];

export type WarmSignals = {
  consent: ConsentState | null;
  /** Replied to or clicked an email, or messaged this number first. */
  hasEngaged: boolean;
  stage: PipelineStage;
};

/**
 * "A dealer enters WhatsApp outreach only if they replied to or clicked an email,
 * messaged the business number first, explicitly opted in, or are already onboarded."
 * An OPT-OUT overrides all of it — consent is per channel and the most recent row wins
 * (§10.2), so a warm dealer who said STOP is not warm any more.
 *
 * This is a guard, not a convention: the send service calls it for every send, and the
 * campaign selector is built from `warmDealerFilter`, so a cold contact cannot reach a
 * WhatsApp send by any path the UI offers.
 */
export function isWarm(s: WarmSignals): boolean {
  if (s.consent === 'OPTED_OUT') return false;
  return s.consent === 'OPTED_IN' || s.hasEngaged || WARM_STAGES.includes(s.stage);
}

// ---- inbound intent → conversation state (§5.3) ------------------------------------

export type Intent = 'STOP' | 'NOT_INTERESTED' | 'NEGOTIATION' | 'PRICING' | 'CATALOG' | 'INTERESTED' | 'OTHER';

// Order matters: a message can match several ("send the price list, I'm not interested"),
// and the safer reading wins — opting out beats everything, declining beats asking.
const INTENTS: [Intent, RegExp][] = [
  ['STOP', /\b(stop|unsubscribe|opt[\s-]?out|remove me|do not (message|contact|text)|don'?t (message|contact|text))\b/i],
  ['NOT_INTERESTED', /\b(not interested|no thanks?|no need|not required|not looking|nahi chahiye|mat bhejo)\b/i],
  ['NEGOTIATION', /\b(negotiat\w*|best price|lower (the )?price|reduce|credit (terms|period)|payment terms|bulk (rate|price|order))\b/i],
  ['PRICING', /\b(price|prices|pricing|rate|rates|cost|quote|quotation|discount|margin|kitna)\b/i],
  ['CATALOG', /\b(catalog(ue)?|brochure|product list|price ?list|products?|pdf|range)\b/i],
  // Deliberately narrow: a bare "ok" or "yes" answers whatever was asked last and is not,
  // by itself, interest — reading it as a buying signal would advance the pipeline on noise.
  ['INTERESTED', /\b(interested|tell me more|call me|send (me )?(the )?details|share (the )?details|haan)\b/i],
];

export function classifyIntent(text: string): Intent {
  const t = text.trim();
  if (!t) return 'OTHER';
  for (const [intent, re] of INTENTS) if (re.test(t)) return intent;
  return 'OTHER';
}

export type Transition = { state: ConversationState; needsHuman: boolean; reason: string | null };

/**
 * A deterministic state machine, not a model decision (§1.5). Nothing here replies:
 * pricing, negotiation and anything unrecognised are commitments or open-ended, so they
 * go to a human inbox rather than an attempt at negotiation (§5.3). Auto-replies for the
 * safe intents belong to the ordering bot (M8), which is where a conversation gets a
 * scripted flow.
 */
export function nextConversation(intent: Intent): Transition {
  switch (intent) {
    case 'STOP':
      return { state: 'NOT_INTERESTED', needsHuman: false, reason: null };
    case 'NOT_INTERESTED':
      return { state: 'NOT_INTERESTED', needsHuman: false, reason: null };
    case 'CATALOG':
      return { state: 'CATALOG', needsHuman: true, reason: 'Asked for the catalogue' };
    case 'PRICING':
      return { state: 'PRICING', needsHuman: true, reason: 'Asked about pricing — a commitment, so a person answers' };
    case 'NEGOTIATION':
      return { state: 'NEGOTIATION', needsHuman: true, reason: 'Negotiating terms — needs a person' };
    case 'INTERESTED':
      return { state: 'IDLE', needsHuman: true, reason: 'Showed interest' };
    default:
      return { state: 'HUMAN', needsHuman: true, reason: 'A message the system does not handle' };
  }
}

/** A positive signal moves CONTACTED → INTERESTED (§5.3). */
export const isPositiveIntent = (i: Intent) => ['CATALOG', 'PRICING', 'NEGOTIATION', 'INTERESTED'].includes(i);

// ---- templates ---------------------------------------------------------------------

/** Dealer fields a {{n}} may be fed from. Money/quantity keys arrive with M7/M6, injected
 *  from the database exactly as §1.4 requires — never typed into a template. */
export const PARAM_KEYS = ['contactName', 'businessName', 'ourBusinessName', 'city', 'state'] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

/** null = valid, otherwise the reason. Mirrors Meta's rules so a template is refused here
 *  with an explanation instead of after a round trip and a vague rejection. */
export function validateTemplate(t: { name: string; bodyText: string; paramKeys: string[] }): string | null {
  if (!/^[a-z0-9_]{1,512}$/.test(t.name)) return 'name may contain only lowercase letters, digits and underscores';
  const body = t.bodyText;
  if (!body.trim()) return 'body is empty';
  if (body.length > 1024) return 'body is longer than 1024 characters';

  const indexes = [...body.matchAll(PLACEHOLDER)].map((m) => Number(m[1]));
  const n = t.paramKeys.length;
  const distinct = [...new Set(indexes)].sort((a, b) => a - b);
  if (distinct.length !== n || distinct.some((v, i) => v !== i + 1)) {
    return `the body must use {{1}}..{{${n}}} exactly once each, matching the ${n} field(s) chosen`;
  }
  if (indexes.length !== distinct.length) return 'each {{n}} placeholder may appear only once';
  const bad = t.paramKeys.find((k) => !(PARAM_KEYS as readonly string[]).includes(k));
  if (bad) return `"${bad}" is not a field a template can use (${PARAM_KEYS.join(', ')})`;
  if (/^\s*\{\{/.test(body) || /\}\}\s*$/.test(body)) return 'Meta rejects a template that starts or ends with a placeholder';
  return null;
}

export function renderTemplate(bodyText: string, params: string[]): string {
  return bodyText.replace(PLACEHOLDER, (whole, i: string) => params[Number(i) - 1] ?? whole);
}

export function paramsFor(keys: string[], fields: Record<string, string | null | undefined>): string[] {
  return keys.map((k) => (fields[k] ?? '').trim() || (k === 'contactName' ? 'Sir/Madam' : '-'));
}

// ---- cost (§7) ---------------------------------------------------------------------

/**
 * India per-message rates, INR, from Meta's rate card as researched 2026-09 (marketing
 * ₹0.8631 after the 2026 revision; utility and authentication ₹0.115). Meta reprices —
 * a hardcoded rate silently drifts, so this is an ESTIMATE shown before a send and is
 * labelled as one; the invoice is the truth. One place to update.
 */
export const RATE_INR = { MARKETING: 0.8631, UTILITY: 0.115, AUTHENTICATION: 0.115 } as const;
export const RATES_AS_OF = '2026-09';

export function estimateCost(category: keyof typeof RATE_INR, count: number) {
  const perMessage = RATE_INR[category];
  return { perMessage, count, total: Math.round(perMessage * count * 100) / 100, asOf: RATES_AS_OF };
}

/** Meta wants the number with country code and no formatting, and our stored form is E.164. */
export const toWaId = (e164: string) => e164.replace(/\D/g, '');
export const fromWaId = (waId: string) => `+${waId.replace(/\D/g, '')}`;
