import { Dealer, PrismaClient } from '@prisma/client';

/**
 * Optional narrowing on top of the §5.2 default (pipelineStage=NEW). Every field is
 * additive — an unset field matches everything, same as leaving it out of a manual
 * query. `dealerIds` is for "send to exactly these dealers" (the dashboard's
 * checkbox-select), and skips the pipelineStage filter entirely when given: a rep
 * picking specific dealers by hand is trusted to know why, the same way `.editAndApprove`
 * trusts a human-typed number (§1.5) — it does NOT skip the consent check below, only
 * the stage filter.
 */
export type OutreachSegmentFilter = {
  pipelineStage?: string;
  city?: string;
  state?: string;
  businessCategory?: string;
  source?: string;
  dealerIds?: string[];
};

/**
 * §5.2 — "dealers where pipelineStage = NEW and current ConsentLog(EMAIL) != OPTED_OUT",
 * extended with optional segment narrowing (OutreachSegmentFilter) for manual batches
 * and scheduled runs. One query for "latest EMAIL consent per dealer" (Prisma `distinct`
 * on an orderBy-desc findMany, backed by the `(dealerId, channel, createdAt)` index)
 * rather than N+1 lookups — still simple, no new abstraction.
 */
export async function eligibleForColdOutreach(
  prisma: PrismaClient,
  filter: OutreachSegmentFilter = {},
): Promise<Dealer[]> {
  const dealers = await prisma.dealer.findMany({
    where: {
      pipelineStage: filter.dealerIds ? undefined : ((filter.pipelineStage ?? 'NEW') as never),
      ...(filter.dealerIds ? { id: { in: filter.dealerIds } } : {}),
      ...(filter.city ? { city: filter.city } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.businessCategory ? { businessCategory: filter.businessCategory } : {}),
      ...(filter.source ? { source: filter.source as never } : {}),
    },
  });
  if (dealers.length === 0) return [];

  const latest = await prisma.consentLog.findMany({
    where: { channel: 'EMAIL', dealerId: { in: dealers.map((d) => d.id) } },
    orderBy: { createdAt: 'desc' },
    distinct: ['dealerId'],
  });
  const optedOut = new Set(latest.filter((c) => c.state === 'OPTED_OUT').map((c) => c.dealerId));
  return dealers.filter((d) => !optedOut.has(d.id));
}
