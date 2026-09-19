import { PrismaClient } from '@prisma/client';
import { normalizeEmail, normalizePhone } from '../contacts/normalize';

export type DealerRef = { name: string; phone: string; email: string };

/**
 * Matches an accounting row to a Dealer — EXACT matches only.
 *
 * Money is attached to whatever this returns. The contacts importer will create a
 * fuzzy match as a separate dealer and ask a human (§5.1); here that is not possible,
 * because an invoice cannot be "provisionally" on a dealer. A wrong attachment
 * silently corrupts two businesses' payment history, so anything short of exact is
 * reported as unmatched and left for a person.
 *
 * Priority: phone (E.164) → email → business name, case-insensitive. A name that
 * matches more than one dealer is ambiguous and is refused for the same reason.
 * Results are cached per import: a 5,000-row file naming 300 dealers is 300 lookups.
 */
export class DealerResolver {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaClient) {}

  async resolve(ref: DealerRef): Promise<string | null> {
    const key = `${ref.phone}|${ref.email}|${ref.name}`.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    const id = await this.lookup(ref);
    this.cache.set(key, id);
    return id;
  }

  private async lookup(ref: DealerRef): Promise<string | null> {
    if (ref.phone) {
      const p = normalizePhone(ref.phone);
      if (p.e164) {
        const hit = await this.prisma.dealerPhone.findFirst({ where: { e164: p.e164 }, orderBy: { id: 'asc' } });
        if (hit) return hit.dealerId;
      }
    }
    if (ref.email) {
      const hit = await this.prisma.dealerEmail.findFirst({
        where: { address: normalizeEmail(ref.email) },
        orderBy: { id: 'asc' },
      });
      if (hit) return hit.dealerId;
    }
    if (ref.name) {
      const hits = await this.prisma.dealer.findMany({
        where: { businessName: { equals: ref.name, mode: 'insensitive' } },
        select: { id: true },
        take: 2,
      });
      if (hits.length === 1) return hits[0].id;
    }
    return null;
  }
}
