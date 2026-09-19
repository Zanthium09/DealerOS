// §5.7 — who a scheme is aimed at, and which orders it gets credit for. Both are
// deterministic rules over database values (§1.5): the model only words the announcement.
import type { PipelineStage } from '@prisma/client';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Stages worth announcing a trade scheme to. Prospects who have never bought are not
 *  scheme targets, and OPTED_OUT / INVALID must never be. */
export const DEFAULT_STAGES: PipelineStage[] = ['ONBOARDED', 'ACTIVE', 'DORMANT', 'REACTIVATED'];
const TARGETABLE = new Set<PipelineStage>(['NEW', 'CONTACTED', 'INTERESTED', ...DEFAULT_STAGES]);

export type SegmentRule = {
  categories?: string[];
  states?: string[];
  cities?: string[];
  stages?: PipelineStage[];
  /** Only dealers who bought one of the scheme's products in the last N days. */
  boughtSchemeProductsWithinDays?: number;
};

const LIST_KEYS = ['categories', 'states', 'cities', 'stages'] as const;

/** null = valid, else why not. Unknown keys are refused: a typo like "categorys" would
 *  otherwise silently widen the audience to everyone. */
export function validateRule(rule: unknown): string | null {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return 'the segment rule must be an object';
  const r = rule as Record<string, unknown>;
  const allowed = new Set<string>([...LIST_KEYS, 'boughtSchemeProductsWithinDays']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return `unknown segment field "${k}"`;
  for (const k of LIST_KEYS) {
    if (r[k] === undefined) continue;
    if (!Array.isArray(r[k]) || (r[k] as unknown[]).some((v) => typeof v !== 'string' || !v.trim())) return `${k} must be a list of text values`;
  }
  for (const s of (r.stages as string[] | undefined) ?? []) {
    if (!TARGETABLE.has(s as PipelineStage)) return `"${s}" cannot be targeted by a scheme`;
  }
  const n = r.boughtSchemeProductsWithinDays;
  if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1)) return 'boughtSchemeProductsWithinDays must be a whole number of days, at least 1';
  return null;
}

export function validateWindow(from: Date, to: Date): string | null {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'the validity dates are not valid';
  if (to.getTime() < from.getTime()) return 'the scheme ends before it starts';
  return null;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const listHas = (list: string[] | undefined, v: string | null | undefined) => !list || list.length === 0 || list.some((x) => norm(x) === norm(v));

export type DealerFacts = {
  pipelineStage: PipelineStage;
  businessCategory: string | null;
  state: string | null;
  city: string | null;
  /** Latest order date containing any scheme product, if any. */
  lastBoughtSchemeProductAt: Date | null;
};

export function matchesSegment(d: DealerFacts, rule: SegmentRule, now: Date): boolean {
  // OPTED_OUT / INVALID are terminal and never stages a rule can name.
  if (!(rule.stages?.length ? rule.stages : DEFAULT_STAGES).includes(d.pipelineStage)) return false;
  if (!listHas(rule.categories, d.businessCategory)) return false;
  if (!listHas(rule.states, d.state)) return false;
  if (!listHas(rule.cities, d.city)) return false;
  if (rule.boughtSchemeProductsWithinDays !== undefined) {
    if (!d.lastBoughtSchemeProductAt) return false;
    if (now.getTime() - d.lastBoughtSchemeProductAt.getTime() > rule.boughtSchemeProductsWithinDays * DAY_MS) return false;
  }
  return true;
}

// ---- attribution ---------------------------------------------------------------------

export type SchemeFacts = { id: string; validFrom: Date; validTo: Date; skus: Set<string>; targetDealerIds: Set<string> };
export type OrderFacts = { dealerId: string; orderDate: Date; skus: string[] };

/** validTo is a calendar day the owner typed: an order at 18:00 on the last day is in. */
const endOfDay = (d: Date) => new Date(d.getTime() + DAY_MS - 1);

/**
 * Which scheme, if any, an order is credited to: the dealer was targeted, the order falls
 * in the validity window, and at least one line is on a scheme product. Several may match;
 * the one that started latest wins (the most specific, most recent promise), ties by id, so
 * the answer never depends on iteration order. An order already tagged is never re-tagged —
 * that is the caller's rule; this only answers "what would match".
 */
export function attributeOrder(order: OrderFacts, schemes: SchemeFacts[]): string | null {
  const hits = schemes.filter(
    (s) =>
      s.targetDealerIds.has(order.dealerId) &&
      order.orderDate >= s.validFrom &&
      order.orderDate <= endOfDay(s.validTo) &&
      order.skus.some((sku) => s.skus.has(sku)),
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime() || (a.id < b.id ? -1 : 1));
  return hits[0].id;
}
