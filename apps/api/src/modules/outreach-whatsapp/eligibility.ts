import type { Dealer, DealerPhone, PrismaClient } from '@prisma/client';
import { WARM_STAGES, WarmSignals } from './rules';

/** The kinds of contact that count as engagement (§7): replied to or clicked an email, or
 *  messaged the business number first. */
const ENGAGEMENT = [
  { channel: 'EMAIL' as const, direction: 'INBOUND' as const },
  { channel: 'EMAIL' as const, status: 'CLICKED' as const },
  { channel: 'WHATSAPP' as const, direction: 'INBOUND' as const },
];

/** The number to WhatsApp: a valid E.164, preferring one marked WhatsApp, then primary. */
export function pickWhatsAppNumber(
  phones: Pick<DealerPhone, 'e164' | 'valid' | 'isWhatsapp' | 'isPrimary'>[],
): string | null {
  const usable = phones.filter((p) => p.valid && p.e164);
  const best = usable.find((p) => p.isWhatsapp) ?? usable.find((p) => p.isPrimary) ?? usable[0];
  return best?.e164 ?? null;
}

/** The signals `isWarm` (rules.ts) judges — gathered here so the send guard and the
 *  selector below are fed the same facts. */
export async function warmSignalsFor(
  prisma: PrismaClient,
  dealer: Pick<Dealer, 'id' | 'pipelineStage'>,
): Promise<WarmSignals> {
  const [consent, engaged] = await Promise.all([
    prisma.consentLog.findFirst({ where: { dealerId: dealer.id, channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' } }),
    prisma.interactionEvent.count({ where: { dealerId: dealer.id, OR: ENGAGEMENT } }),
  ]);
  return { consent: consent?.state ?? null, hasEngaged: engaged > 0, stage: dealer.pipelineStage };
}

/**
 * The warm-routing query (§7): "implement as a query filter that cannot be bypassed from
 * the UI". Campaigns are built ONLY from this — there is no parameter that widens it, and
 * `dealerIds` can only NARROW it (a rep picking specific dealers still gets the guard).
 *
 * Latest-consent-wins needs the newest row per dealer, which Prisma cannot express in a
 * `where`, so it is two steps (the same shape as email's eligibleForColdOutreach):
 * dealers warm by stage or engagement, plus dealers whose latest consent is OPTED_IN,
 * minus everyone whose latest consent is OPTED_OUT.
 */
export async function eligibleWarmDealers(
  prisma: PrismaClient,
  opts: { limit?: number; dealerIds?: string[] } = {},
): Promise<(Dealer & { phones: DealerPhone[] })[]> {
  const hasNumber = { phones: { some: { valid: true, e164: { not: null } } } };
  const scope = opts.dealerIds ? { id: { in: opts.dealerIds } } : {};

  const [warm, latestConsent] = await Promise.all([
    prisma.dealer.findMany({
      where: {
        ...scope,
        ...hasNumber,
        OR: [{ pipelineStage: { in: WARM_STAGES } }, { interactionEvents: { some: { OR: ENGAGEMENT } } }],
      },
      include: { phones: true },
    }),
    prisma.consentLog.findMany({ where: { channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, distinct: ['dealerId'] }),
  ]);

  const optedOut = new Set(latestConsent.filter((c) => c.state === 'OPTED_OUT').map((c) => c.dealerId));
  const have = new Set(warm.map((d) => d.id));
  const optedInOnly = latestConsent
    .filter((c) => c.state === 'OPTED_IN' && !have.has(c.dealerId) && (!opts.dealerIds || opts.dealerIds.includes(c.dealerId)))
    .map((c) => c.dealerId);
  const extra = optedInOnly.length
    ? await prisma.dealer.findMany({ where: { id: { in: optedInOnly }, ...hasNumber }, include: { phones: true } })
    : [];

  const out = [...warm, ...extra].filter((d) => !optedOut.has(d.id));
  return opts.limit ? out.slice(0, opts.limit) : out;
}
