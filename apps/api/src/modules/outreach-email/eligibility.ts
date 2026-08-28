import { Dealer, PrismaClient } from '@prisma/client';

/**
 * §5.2 — "dealers where pipelineStage = NEW and current ConsentLog(EMAIL) != OPTED_OUT".
 * One query for "latest EMAIL consent per dealer" (Prisma `distinct` on an
 * orderBy-desc findMany, backed by the `(dealerId, channel, createdAt)` index) rather
 * than N+1 lookups — still simple, no new abstraction.
 */
export async function eligibleForColdOutreach(prisma: PrismaClient): Promise<Dealer[]> {
  const dealers = await prisma.dealer.findMany({ where: { pipelineStage: 'NEW' } });
  if (dealers.length === 0) return [];

  const latest = await prisma.consentLog.findMany({
    where: { channel: 'EMAIL', dealerId: { in: dealers.map((d) => d.id) } },
    orderBy: { createdAt: 'desc' },
    distinct: ['dealerId'],
  });
  const optedOut = new Set(latest.filter((c) => c.state === 'OPTED_OUT').map((c) => c.dealerId));
  return dealers.filter((d) => !optedOut.has(d.id));
}
