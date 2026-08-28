import { ConsentChannel, ConsentSource, ConsentState, PrismaClient } from '@prisma/client';

/**
 * §10.2 — "most recent ConsentLog row per channel wins, channels are independent".
 * One function, called everywhere a send decision is made, so there is exactly one
 * place that can get consent precedence wrong.
 */
export async function currentConsentState(
  prisma: PrismaClient,
  dealerId: string,
  channel: ConsentChannel,
): Promise<ConsentState | null> {
  const row = await prisma.consentLog.findFirst({
    where: { dealerId, channel },
    orderBy: { createdAt: 'desc' },
  });
  return row?.state ?? null;
}

/** §5.2 — "current ConsentLog(EMAIL) != OPTED_OUT". No row at all is not opted out. */
export function isEligibleForEmail(state: ConsentState | null): boolean {
  return state !== 'OPTED_OUT';
}

/** Append-only write, never an update — §1.6, §4. */
export function writeConsent(
  prisma: PrismaClient,
  args: { organizationId: string; dealerId: string; channel: ConsentChannel; state: ConsentState; source: ConsentSource },
) {
  return prisma.consentLog.create({ data: args });
}
