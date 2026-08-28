// §5.1 / §10.1 — "merges are logged as reversible operations". Reversal is
// implemented here, because a logged merge that cannot actually be undone is not a
// reversible operation, it is a comment.
//
// What a merge does NOT do: delete the merged dealer. Its ConsentLog rows are
// append-only (§1.6, Postgres trigger) and point at it, so deleting it would either
// fail or orphan the DPDP trail. The merged dealer is parked at the terminal stage
// INVALID with its dedupeKey cleared, so it stops matching and stops being outreach
// material, and every row that ever referred to it still resolves.
//
// Consent across a merge:
//   * The merged dealer's ConsentLog rows stay exactly where they are — untouched,
//     attributable to the identity that actually gave (or refused) consent.
//   * An OPTED_OUT is the one thing carried forward: a fresh ConsentLog row is
//     APPENDED to the surviving dealer, keeping the original `source` so the trail
//     says why. Losing an opt-out in a merge would mean messaging someone who said no.
//   * An OPTED_IN is NEVER carried forward. Consent given to one record is not
//     consent for another, and DPDP 2023 has no legitimate-interest escape hatch.
//   * Reversal cannot delete those appended rows (append-only). The survivor keeps an
//     inherited opt-out it did not originally have — strictly the safe direction.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConsentChannel, Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { AuditAction, AuditService } from '../../core/audit';

export type MergeInput = {
  survivingDealerId: string;
  mergedDealerId: string;
  userId?: string | null;
  /** The DuplicateCandidate this resolves, if the merge came from the review queue. */
  candidateId?: string | null;
};

type MergeSnapshot = {
  merged: { id: string; pipelineStage: string; dedupeKey: string | null; businessName: string };
  movedPhoneIds: string[];
  movedEmailIds: string[];
  carriedConsent: { channel: ConsentChannel; source: string }[];
};

const CHANNELS: ConsentChannel[] = ['EMAIL', 'WHATSAPP', 'CALL'];

@Injectable()
export class MergeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async merge(input: MergeInput): Promise<{ mergeId: string }> {
    const { survivingDealerId, mergedDealerId } = input;
    if (survivingDealerId === mergedDealerId) {
      throw new BadRequestException('A dealer cannot be merged into itself.');
    }

    // Both reads go through the scoped client, so a dealer in another org is simply
    // not found — a cross-org merge is impossible here, not merely discouraged (§1.3).
    const [surviving, merged] = await Promise.all([
      this.prisma.dealer.findUnique({
        where: { id: survivingDealerId },
        include: { phones: true, emails: true },
      }),
      this.prisma.dealer.findUnique({
        where: { id: mergedDealerId },
        include: { phones: true, emails: true, consentLogs: true },
      }),
    ]);
    if (!surviving || !merged) throw new NotFoundException('Dealer not found.');

    // INVALID is where merge() parks a dealer it merged away. Merging one again — in
    // either position — parks BOTH records at INVALID with dedupeKey null, and one
    // reversal only brings one side back: two clicks in the review queue in the wrong
    // order silently kill a real business (§5.1, §10.1). Reverse the first merge first.
    if (merged.pipelineStage === 'INVALID' || surviving.pipelineStage === 'INVALID') {
      throw new BadRequestException('A merged-away dealer cannot take part in another merge.');
    }

    const snapshot: MergeSnapshot = {
      merged: {
        id: merged.id,
        pipelineStage: merged.pipelineStage,
        dedupeKey: merged.dedupeKey,
        businessName: merged.businessName,
      },
      movedPhoneIds: merged.phones.map((p) => p.id),
      movedEmailIds: merged.emails.map((e) => e.id),
      carriedConsent: [],
    };

    return this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as PrismaClient;
      // Inside the transaction, not before it: an opt-out landing between the read and
      // the write would otherwise be left behind on a dealer whose phone has already
      // moved — i.e. someone who said "stop" could be messaged after a merge (§1.6).
      const carriedConsent = await this.optOutsToCarry(surviving.id, merged.id, t);
      snapshot.carriedConsent = carriedConsent;
      // The rows move as they are. isPrimary is not unique-constrained and nothing
      // reads it to pick "the" number, so clearing it bought nothing and cost the
      // reversal: a merge-then-reverse used to hand back a dealer with contact points
      // and no primary one, which is not "fully reversible" (§10.1).
      await t.dealerPhone.updateMany({
        where: { dealerId: merged.id },
        data: { dealerId: surviving.id },
      });
      await t.dealerEmail.updateMany({
        where: { dealerId: merged.id },
        data: { dealerId: surviving.id },
      });
      for (const c of carriedConsent) {
        await t.consentLog.create({
          data: {
            organizationId: surviving.organizationId,
            dealerId: surviving.id,
            channel: c.channel,
            state: 'OPTED_OUT',
            source: c.source as never,
          },
        });
      }
      await t.dealer.update({
        where: { id: merged.id },
        data: { pipelineStage: 'INVALID', dedupeKey: null },
      });

      const record = await t.dealerMerge.create({
        data: {
          organizationId: surviving.organizationId,
          survivingDealerId: surviving.id,
          mergedDealerId: merged.id,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          createdByUserId: input.userId ?? null,
        },
      });

      if (input.candidateId) {
        await t.duplicateCandidate.update({
          where: { id: input.candidateId },
          data: {
            status: 'MERGED',
            reviewedByUserId: input.userId ?? null,
            reviewedAt: new Date(),
          },
        });
      }

      await this.audit.record(
        {
          actorType: input.userId ? 'USER' : 'SYSTEM',
          actorId: input.userId ?? null,
          organizationId: surviving.organizationId,
          entityType: 'Dealer',
          entityId: surviving.id,
          action: AuditAction.DEALER_MERGED,
          metadata: { mergeId: record.id, mergedDealerId: merged.id, snapshot } as never,
        },
        tx as unknown as Prisma.TransactionClient,
      );

      return { mergeId: record.id };
    });
  }

  /** Reverse a merge: contact points go back, the merged dealer returns to its stage. */
  async reverse(mergeId: string, userId?: string | null): Promise<void> {
    const record = await this.prisma.dealerMerge.findUnique({ where: { id: mergeId } });
    if (!record) throw new NotFoundException('Merge not found.');
    if (record.reversedAt) throw new BadRequestException('Merge is already reversed.');
    const snapshot = record.snapshot as unknown as MergeSnapshot;

    await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as PrismaClient;
      if (snapshot.movedPhoneIds.length) {
        await t.dealerPhone.updateMany({
          where: { id: { in: snapshot.movedPhoneIds } },
          data: { dealerId: record.mergedDealerId },
        });
      }
      if (snapshot.movedEmailIds.length) {
        await t.dealerEmail.updateMany({
          where: { id: { in: snapshot.movedEmailIds } },
          data: { dealerId: record.mergedDealerId },
        });
      }
      await t.dealer.update({
        where: { id: record.mergedDealerId },
        data: {
          pipelineStage: snapshot.merged.pipelineStage as never,
          dedupeKey: snapshot.merged.dedupeKey,
        },
      });
      await t.dealerMerge.update({ where: { id: mergeId }, data: { reversedAt: new Date() } });

      // Same action, opposite direction — audit.actions.ts is core and owned
      // elsewhere, so the direction lives in the metadata rather than in a new
      // constant nobody else has agreed to yet.
      await this.audit.record(
        {
          actorType: userId ? 'USER' : 'SYSTEM',
          actorId: userId ?? null,
          organizationId: record.organizationId,
          entityType: 'Dealer',
          entityId: record.survivingDealerId,
          action: AuditAction.DEALER_MERGED,
          metadata: {
            reversed: true,
            mergeId,
            mergedDealerId: record.mergedDealerId,
            // The carried opt-outs stay on the survivor — append-only, see the
            // module comment. Named here so the trail says so out loud.
            consentRowsLeftInPlace: snapshot.carriedConsent.length,
          } as never,
        },
        tx as unknown as Prisma.TransactionClient,
      );
    });
  }

  /** Channels where the merged dealer is OPTED_OUT and the survivor is not. */
  private async optOutsToCarry(
    survivingDealerId: string,
    mergedDealerId: string,
    db: PrismaClient = this.prisma,
  ): Promise<{ channel: ConsentChannel; source: string }[]> {
    const carry: { channel: ConsentChannel; source: string }[] = [];
    for (const channel of CHANNELS) {
      const [mergedState, survivingState] = await Promise.all([
        this.latestConsent(db, mergedDealerId, channel),
        this.latestConsent(db, survivingDealerId, channel),
      ]);
      if (mergedState?.state === 'OPTED_OUT' && survivingState?.state !== 'OPTED_OUT') {
        carry.push({ channel, source: mergedState.source });
      }
    }
    return carry;
  }

  /** §10.2 — most recent row per (dealerId, channel) wins. */
  private latestConsent(db: PrismaClient, dealerId: string, channel: ConsentChannel) {
    return db.consentLog.findFirst({
      where: { dealerId, channel },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}
