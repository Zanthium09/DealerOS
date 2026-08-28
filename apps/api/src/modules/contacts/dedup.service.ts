// §5.1 / §10.1 — the dedup decision, in one place. M0 (§5.0) calls this service
// rather than growing a second implementation.
//
// Match priority, exactly as §5.1 states:
//   1. exact phoneE164   → CONFIRMED duplicate
//   2. exact email       → CONFIRMED duplicate
//   3. fuzzy businessName + city (pg_trgm) → NEVER a merge. A human decides.
import { Inject, Injectable } from '@nestjs/common';
import { MatchReason, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import type { NormalizedRow } from './normalize';

/** Above this, two names in the same city are worth a human's attention. */
export const FUZZY_THRESHOLD = 0.4;

export type DedupMatch = {
  dealerId: string;
  reason: MatchReason;
  score: number | null;
  /** false only for FUZZY_NAME_CITY — see §5.1: never auto-merge on fuzzy. */
  confirmed: boolean;
};

@Injectable()
export class DedupService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async findMatch(row: NormalizedRow, excludeDealerId?: string): Promise<DedupMatch | null> {
    const e164s = row.phones.map((p) => p.e164).filter((p): p is string => !!p);
    if (e164s.length) {
      const hit = await this.prisma.dealerPhone.findFirst({
        where: { e164: { in: e164s }, ...(excludeDealerId ? { dealerId: { not: excludeDealerId } } : {}) },
        orderBy: { id: 'asc' },
      });
      if (hit) return { dealerId: hit.dealerId, reason: 'PHONE_E164', score: 1, confirmed: true };
    }

    if (row.emails.length) {
      const hit = await this.prisma.dealerEmail.findFirst({
        where: { address: { in: row.emails }, ...(excludeDealerId ? { dealerId: { not: excludeDealerId } } : {}) },
        orderBy: { id: 'asc' },
      });
      if (hit) return { dealerId: hit.dealerId, reason: 'EMAIL', score: 1, confirmed: true };
    }

    // §5.1 pairs the name with the city; a name alone matches half the market.
    if (!row.city) return null;
    const fuzzy = await this.fuzzyNameCity(row.businessName, row.city, excludeDealerId);
    return fuzzy && { ...fuzzy, reason: 'FUZZY_NAME_CITY', confirmed: false };
  }

  /**
   * pg_trgm's similarity() has no Prisma equivalent, so this is raw SQL — and raw
   * SQL BYPASSES the tenancy extension (tenancy.ts, "Known gaps" #1). The
   * `"organizationId" = $1` below is therefore load-bearing, not decoration: it is
   * the ONLY thing scoping this query. getOrgId() is the same context the extension
   * reads, and a missing context throws here exactly as it would there (§1.3).
   */
  private async fuzzyNameCity(
    businessName: string,
    city: string,
    excludeDealerId?: string,
  ): Promise<{ dealerId: string; score: number } | null> {
    const organizationId = getOrgId();
    if (!organizationId) {
      throw new Error(
        'tenancy: DedupService fuzzy match has no org context — refusing to run an ' +
          'unscoped raw query (§1.3).',
      );
    }
    const rows = await this.prisma.$queryRaw<{ id: string; score: number }[]>`
      SELECT d."id", similarity(d."businessName", ${businessName}) AS score
      FROM "Dealer" d
      WHERE d."organizationId" = ${organizationId}
        AND lower(d."city") = lower(${city})
        AND d."id" <> ${excludeDealerId ?? ''}
        AND similarity(d."businessName", ${businessName}) >= ${FUZZY_THRESHOLD}
      ORDER BY score DESC, d."id" ASC
      LIMIT 1
    `;
    return rows[0] ? { dealerId: rows[0].id, score: Number(rows[0].score) } : null;
  }
}
