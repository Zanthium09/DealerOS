// M1 merge + reversal (§5.1, §10.1 — "merges are logged as reversible operations").
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { MergeService } from '../../src/modules/contacts/merge.service';

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;
const merges = new MergeService(db, new AuditService(db));

const ORG_A = 'merge-org-a';
const ORG_B = 'merge-org-b';
const USER_A = 'merge-user-a';

let n = 0;
async function makeDealer(orgId: string, businessName: string) {
  const suffix = `${orgId}-${n++}`;
  return raw.dealer.create({
    data: {
      organizationId: orgId,
      businessName,
      city: 'Pune',
      source: 'IMPORTED_LIST',
      dedupeKey: `k:${suffix}`,
      phones: { create: [{ raw: suffix, e164: null, isPrimary: true }] },
      emails: { create: [{ address: `${suffix}@test.local`, isPrimary: true }] },
      consentLogs: {
        create: [{ channel: 'EMAIL', state: 'UNKNOWN', source: 'IMPORT_DEFAULT' }],
      },
    },
    include: { phones: true, emails: true },
  });
}

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Merge A', slug: ORG_A },
      { id: ORG_B, name: 'Merge B', slug: ORG_B },
    ],
  });
  await raw.user.create({
    data: {
      id: USER_A,
      organizationId: ORG_A,
      email: 'merge-owner@test.local',
      passwordHash: 'x',
      role: 'OWNER',
    },
  });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('merge (§5.1, §10.1)', () => {
  test('moves contact points, parks the merged dealer, and is fully reversible', async () => {
    const surviving = await makeDealer(ORG_A, 'Keep Traders');
    const merged = await makeDealer(ORG_A, 'Duplicate Traders');

    const { mergeId } = await runWithOrg(ORG_A, () =>
      merges.merge({
        survivingDealerId: surviving.id,
        mergedDealerId: merged.id,
        userId: USER_A,
      }),
    );

    const afterMerge = await raw.dealer.findUniqueOrThrow({
      where: { id: merged.id },
      include: { phones: true, emails: true, consentLogs: true },
    });
    assert.equal(afterMerge.pipelineStage, 'INVALID', 'parked, not deleted');
    assert.equal(afterMerge.dedupeKey, null, 'stops matching future imports');
    assert.equal(afterMerge.phones.length, 0);
    assert.equal(afterMerge.emails.length, 0);
    assert.equal(afterMerge.consentLogs.length, 1, 'its own consent trail stays attributable');

    const survivorNow = await raw.dealer.findUniqueOrThrow({
      where: { id: surviving.id },
      include: { phones: true, emails: true },
    });
    assert.equal(survivorNow.phones.length, 2);
    assert.equal(survivorNow.emails.length, 2);

    const record = await raw.dealerMerge.findUniqueOrThrow({ where: { id: mergeId } });
    assert.equal(record.organizationId, ORG_A);
    assert.equal(record.reversedAt, null);
    assert.equal(record.createdByUserId, USER_A);

    const merges1 = await raw.auditEvent.findMany({
      where: { organizationId: ORG_A, entityId: surviving.id, action: 'DEALER_MERGED' },
    });
    assert.equal(merges1.length, 1);
    assert.equal(merges1[0].actorId, USER_A);

    // ---- reverse ----
    await runWithOrg(ORG_A, () => merges.reverse(mergeId, USER_A));

    const backAgain = await raw.dealer.findUniqueOrThrow({
      where: { id: merged.id },
      include: { phones: true, emails: true },
    });
    assert.equal(backAgain.pipelineStage, 'NEW', 'restored from the snapshot');
    assert.equal(backAgain.dedupeKey, merged.dedupeKey);
    assert.equal(backAgain.phones.length, 1);
    assert.equal(backAgain.emails.length, 1);
    assert.equal(
      (await raw.dealer.findUniqueOrThrow({ where: { id: surviving.id }, include: { phones: true } }))
        .phones.length,
      1,
    );

    const reversed = await raw.dealerMerge.findUniqueOrThrow({ where: { id: mergeId } });
    assert.ok(reversed.reversedAt instanceof Date);

    const events = await raw.auditEvent.findMany({
      where: { organizationId: ORG_A, entityId: surviving.id, action: 'DEALER_MERGED' },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(events.length, 2, 'both directions are audited');
    assert.equal((events[1].metadata as { reversed?: boolean }).reversed, true);

    await runWithOrg(ORG_A, async () => {
      await assert.rejects(() => merges.reverse(mergeId, USER_A), /already reversed/i);
    });
  });

  test('an OPTED_OUT is carried forward; consent history is never rewritten', async () => {
    const surviving = await makeDealer(ORG_A, 'Consent Survivor');
    const merged = await makeDealer(ORG_A, 'Consent Merged');
    await raw.consentLog.create({
      data: {
        organizationId: ORG_A,
        dealerId: merged.id,
        channel: 'EMAIL',
        state: 'OPTED_OUT',
        source: 'BOUNCE',
      },
    });

    const { mergeId } = await runWithOrg(ORG_A, () =>
      merges.merge({ survivingDealerId: surviving.id, mergedDealerId: merged.id, userId: USER_A }),
    );

    const survivorConsent = await raw.consentLog.findMany({
      where: { dealerId: surviving.id, channel: 'EMAIL' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(survivorConsent[0].state, 'OPTED_OUT', 'an opt-out is never lost in a merge');
    assert.equal(survivorConsent[0].source, 'BOUNCE', 'and says where it came from');

    // The merged dealer's own rows are untouched — append-only, still attributable.
    const mergedConsent = await raw.consentLog.findMany({ where: { dealerId: merged.id } });
    assert.equal(mergedConsent.length, 2);

    // Reversal leaves the inherited opt-out in place: ConsentLog cannot be deleted,
    // and erring towards "do not contact" is the safe direction.
    await runWithOrg(ORG_A, () => merges.reverse(mergeId, USER_A));
    const stillOptedOut = await raw.consentLog.findFirstOrThrow({
      where: { dealerId: surviving.id, channel: 'EMAIL' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(stillOptedOut.state, 'OPTED_OUT');
  });

  test('an UNKNOWN or OPTED_IN state is NOT carried forward', async () => {
    const surviving = await makeDealer(ORG_A, 'No Carry Survivor');
    const merged = await makeDealer(ORG_A, 'No Carry Merged');
    await raw.consentLog.create({
      data: {
        organizationId: ORG_A,
        dealerId: merged.id,
        channel: 'WHATSAPP',
        state: 'OPTED_IN',
        source: 'VERBAL',
      },
    });

    await runWithOrg(ORG_A, () =>
      merges.merge({ survivingDealerId: surviving.id, mergedDealerId: merged.id }),
    );

    const survivorWhatsapp = await raw.consentLog.count({
      where: { dealerId: surviving.id, channel: 'WHATSAPP' },
    });
    assert.equal(survivorWhatsapp, 0, 'consent given to one record is not consent for another');
  });

  test('a dealer cannot be merged into itself', async () => {
    const d = await makeDealer(ORG_A, 'Self Merge');
    await runWithOrg(ORG_A, async () => {
      await assert.rejects(
        () => merges.merge({ survivingDealerId: d.id, mergedDealerId: d.id }),
        /itself/i,
      );
    });
  });

  test('a PENDING duplicate candidate is closed by the merge that resolves it', async () => {
    const surviving = await makeDealer(ORG_A, 'Candidate Survivor');
    const merged = await makeDealer(ORG_A, 'Candidate Merged');
    const candidate = await raw.duplicateCandidate.create({
      data: {
        organizationId: ORG_A,
        matchedDealerId: surviving.id,
        incomingPayload: { createdDealerId: merged.id },
        matchReason: 'FUZZY_NAME_CITY',
        matchScore: 0.7,
      },
    });

    await runWithOrg(ORG_A, () =>
      merges.merge({
        survivingDealerId: surviving.id,
        mergedDealerId: merged.id,
        userId: USER_A,
        candidateId: candidate.id,
      }),
    );

    const closed = await raw.duplicateCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    assert.equal(closed.status, 'MERGED');
    assert.equal(closed.reviewedByUserId, USER_A);
  });
});

describe('org scoping (§1.3)', () => {
  test('a dealer in another org cannot be merged, in either position', async () => {
    const inA = await makeDealer(ORG_A, 'Scoped A');
    const inB = await makeDealer(ORG_B, 'Scoped B');

    await runWithOrg(ORG_A, async () => {
      await assert.rejects(
        () => merges.merge({ survivingDealerId: inA.id, mergedDealerId: inB.id }),
        /not found/i,
      );
      await assert.rejects(
        () => merges.merge({ survivingDealerId: inB.id, mergedDealerId: inA.id }),
        /not found/i,
      );
    });

    const untouched = await raw.dealer.findUniqueOrThrow({
      where: { id: inB.id },
      include: { phones: true },
    });
    assert.equal(untouched.pipelineStage, 'NEW');
    assert.equal(untouched.phones.length, 1);
  });

  test("another org's merge cannot be reversed", async () => {
    const surviving = await makeDealer(ORG_A, 'Reverse Scoped Survivor');
    const merged = await makeDealer(ORG_A, 'Reverse Scoped Merged');
    const { mergeId } = await runWithOrg(ORG_A, () =>
      merges.merge({ survivingDealerId: surviving.id, mergedDealerId: merged.id }),
    );

    await runWithOrg(ORG_B, async () => {
      await assert.rejects(() => merges.reverse(mergeId), /not found/i);
    });
    assert.equal(
      (await raw.dealerMerge.findUniqueOrThrow({ where: { id: mergeId } })).reversedAt,
      null,
    );
  });
});
