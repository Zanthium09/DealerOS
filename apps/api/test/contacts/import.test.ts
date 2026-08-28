// M1 import + dedup (§5.1, §10.1, §13 — dedup is a money path).
// Real Postgres, real Prisma, real pg_trgm. Nothing mocked.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { DedupService } from '../../src/modules/contacts/dedup.service';
import { ImportService } from '../../src/modules/contacts/import.service';
import { normalizeRow } from '../../src/modules/contacts/normalize';

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;
const dedup = new DedupService(db);
const imports = new ImportService(db, dedup);

const ORG_A = 'contacts-org-a';
const ORG_B = 'contacts-org-b';

const MAPPING = {
  businessName: 'Firm Name',
  contactPersonName: 'Contact Person',
  phone: ['Mobile No'],
  email: ['Email ID'],
  city: 'City',
};

const file = (body: string) => Buffer.from(`Firm Name,Contact Person,Mobile No,Email ID,City\n${body}`);

/** Start a batch and run it in one go — the two-step API, exercised end to end. */
async function importCsv(orgId: string, body: string, source = 'IMPORTED_LIST') {
  return runWithOrg(orgId, async () => {
    const preview = await imports.startBatch({
      filename: 'dealers.csv',
      buffer: file(body),
      source: source as never,
    });
    return imports.runBatch(preview.batchId, file(body), MAPPING as never);
  });
}

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Contacts A', slug: ORG_A },
      { id: ORG_B, name: 'Contacts B', slug: ORG_B },
    ],
  });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('import batch basics (§5.1)', () => {
  test('a batch without a valid source is refused — source is mandatory', async () => {
    await runWithOrg(ORG_A, async () => {
      await assert.rejects(
        () =>
          imports.startBatch({
            filename: 'x.csv',
            buffer: file('A,,,,\n'),
            source: undefined as never,
          }),
        /source is mandatory/i,
      );
      await assert.rejects(
        () =>
          imports.startBatch({
            filename: 'x.csv',
            buffer: file('A,,,,\n'),
            source: 'PURCHASED_LIST' as never,
          }),
        /source is mandatory/i,
      );
    });
  });

  test('startBatch detects headers, suggests a mapping and parks the batch at MAPPING', async () => {
    const preview = await runWithOrg(ORG_A, () =>
      imports.startBatch({
        filename: 'dealers.csv',
        buffer: file('Acme,Ravi,9876500001,acme@test.local,Pune\n'),
        source: 'TRADE_FAIR' as never,
      }),
    );
    assert.equal(preview.rowCount, 1);
    assert.equal(preview.suggestedMapping.businessName, 'Firm Name');
    const batch = await raw.importBatch.findUniqueOrThrow({ where: { id: preview.batchId } });
    assert.equal(batch.status, 'MAPPING');
    assert.equal(batch.source, 'TRADE_FAIR');
    assert.equal(batch.organizationId, ORG_A);
  });

  test('the confirmed mapping is persisted on the batch before any row is written', async () => {
    const result = await importCsv(ORG_A, 'Mapping Co,Ravi,9876500002,mapping@test.local,Pune\n');
    const batch = await raw.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    assert.equal(batch.status, 'COMPLETED');
    assert.deepEqual(batch.columnMapping, MAPPING);
    assert.equal(batch.createdCount, 1);
  });

  test('a row with no business name is counted invalid, not imported', async () => {
    const result = await importCsv(ORG_A, ',Ravi,9876500003,,Pune\n');
    assert.equal(result.invalidCount, 1);
    assert.equal(result.createdCount, 0);
  });
});

describe('new dealers (§5.1, §1.6)', () => {
  test('creates the dealer with both raw and E.164, and flags the unparseable one', async () => {
    await importCsv(ORG_A, 'Phone Co,Ravi,not-a-number,phoneco@test.local,Pune\n');
    const dealer = await raw.dealer.findFirstOrThrow({
      where: { organizationId: ORG_A, businessName: 'Phone Co' },
      include: { phones: true, emails: true },
    });
    assert.equal(dealer.pipelineStage, 'NEW');
    assert.equal(dealer.source, 'IMPORTED_LIST');
    assert.equal(dealer.phones.length, 1, 'the unparseable number is kept, not dropped');
    assert.equal(dealer.phones[0].raw, 'not-a-number');
    assert.equal(dealer.phones[0].e164, null);
    assert.equal(dealer.phones[0].valid, false);
    assert.equal(dealer.emails[0].address, 'phoneco@test.local');
  });

  test('ConsentLog is written UNKNOWN / IMPORT_DEFAULT per channel — never OPTED_IN', async () => {
    await importCsv(ORG_A, 'Consent Co,Ravi,9876500010,consent@test.local,Pune\n');
    const dealer = await raw.dealer.findFirstOrThrow({
      where: { organizationId: ORG_A, businessName: 'Consent Co' },
      include: { consentLogs: true },
    });
    assert.deepEqual(
      dealer.consentLogs.map((c) => c.channel).sort(),
      ['CALL', 'EMAIL', 'WHATSAPP'],
    );
    for (const c of dealer.consentLogs) {
      assert.equal(c.state, 'UNKNOWN', 'importing a list is not consent');
      assert.equal(c.source, 'IMPORT_DEFAULT');
    }
    const optedIn = await raw.consentLog.count({
      where: { organizationId: ORG_A, state: 'OPTED_IN' },
    });
    assert.equal(optedIn, 0);
  });
});

describe('match priority (§5.1): phone → email → fuzzy', () => {
  test('1. exact phoneE164 is a confirmed duplicate — no second dealer', async () => {
    await importCsv(ORG_A, 'Priority One,Ravi,9876511111,p1@test.local,Pune\n');
    // Different name, different email, SAME number.
    const again = await importCsv(ORG_A, 'Totally Different Name,Sunil,9876511111,other@test.local,Mumbai\n');

    assert.equal(again.duplicateCount, 1);
    assert.equal(again.createdCount, 0);
    const dealers = await raw.dealer.count({
      where: { organizationId: ORG_A, phones: { some: { e164: '+919876511111' } } },
    });
    assert.equal(dealers, 1);

    const candidate = await raw.duplicateCandidate.findFirstOrThrow({
      where: { organizationId: ORG_A, importBatchId: again.batchId },
    });
    assert.equal(candidate.matchReason, 'PHONE_E164');
    assert.equal(candidate.status, 'MERGED');

    // Additive only: the incoming email joins the matched dealer, its name does not.
    const matched = await raw.dealer.findUniqueOrThrow({
      where: { id: candidate.matchedDealerId },
      include: { emails: true },
    });
    assert.equal(matched.businessName, 'Priority One');
    assert.deepEqual(matched.emails.map((e) => e.address).sort(), ['other@test.local', 'p1@test.local']);
  });

  test('2. exact email is a confirmed duplicate when no phone matches', async () => {
    await importCsv(ORG_A, 'Email Match Co,Ravi,9876522222,shared@test.local,Pune\n');
    const again = await importCsv(ORG_A, 'Another Name,Sunil,9876533333,SHARED@test.local,Pune\n');

    assert.equal(again.duplicateCount, 1);
    assert.equal(again.createdCount, 0);
    const candidate = await raw.duplicateCandidate.findFirstOrThrow({
      where: { organizationId: ORG_A, importBatchId: again.batchId },
    });
    assert.equal(candidate.matchReason, 'EMAIL');
  });

  test('phone wins over email when both would match different dealers', async () => {
    await importCsv(ORG_A, 'Phone Owner,Ravi,9876544444,phoneowner@test.local,Pune\n');
    await importCsv(ORG_A, 'Email Owner,Ravi,9876555555,emailowner@test.local,Pune\n');
    const again = await importCsv(ORG_A, 'Third Co,Ravi,9876544444,emailowner@test.local,Pune\n');

    const candidate = await raw.duplicateCandidate.findFirstOrThrow({
      where: { organizationId: ORG_A, importBatchId: again.batchId },
    });
    assert.equal(candidate.matchReason, 'PHONE_E164');
    const phoneOwner = await raw.dealer.findFirstOrThrow({
      where: { organizationId: ORG_A, businessName: 'Phone Owner' },
    });
    assert.equal(candidate.matchedDealerId, phoneOwner.id);
  });

  test('3. fuzzy name + city NEVER auto-merges — both dealers exist, a human is asked', async () => {
    await importCsv(ORG_A, 'Sharma Electricals,Ravi,9876566666,sharma@test.local,Solapur\n');
    const again = await importCsv(ORG_A, 'Sharma Electrical,Sunil,9876577777,sharma2@test.local,Solapur\n');

    assert.equal(again.createdCount, 1, 'the incoming row became its own dealer');
    assert.equal(again.duplicateCount, 0, 'and was NOT absorbed into the existing one');
    assert.equal(again.flaggedCount, 1);

    const both = await raw.dealer.count({
      where: { organizationId: ORG_A, city: 'Solapur' },
    });
    assert.equal(both, 2);

    const candidate = await raw.duplicateCandidate.findFirstOrThrow({
      where: { organizationId: ORG_A, importBatchId: again.batchId },
    });
    assert.equal(candidate.matchReason, 'FUZZY_NAME_CITY');
    assert.equal(candidate.status, 'PENDING', 'the review queue, not a merge');
    assert.ok((candidate.matchScore ?? 0) > 0.4 && (candidate.matchScore ?? 0) < 1);
    // Nothing was merged: no DealerMerge row exists for this org yet.
    assert.equal(await raw.dealerMerge.count({ where: { organizationId: ORG_A } }), 0);
  });

  test('a similar name in a DIFFERENT city is not flagged at all', async () => {
    await importCsv(ORG_A, 'Verma Hardware,Ravi,9876588888,verma@test.local,Nagpur\n');
    const again = await importCsv(ORG_A, 'Verma Hardwares,Sunil,9876599999,verma2@test.local,Kolhapur\n');
    assert.equal(again.flaggedCount, 0);
    assert.equal(again.createdCount, 1);
  });
});

describe('org scoping (§1.3, §13 — including the raw pg_trgm query)', () => {
  test('an identical phone in another org is not a duplicate', async () => {
    await importCsv(ORG_A, 'Cross Org Phone,Ravi,9876600001,crossphone@test.local,Pune\n');
    const inB = await importCsv(ORG_B, 'Cross Org Phone,Ravi,9876600001,crossphone@test.local,Pune\n');

    assert.equal(inB.duplicateCount, 0);
    assert.equal(inB.createdCount, 1);
    assert.equal(await raw.dealer.count({ where: { organizationId: ORG_B } }), 1);
    assert.equal(await raw.duplicateCandidate.count({ where: { organizationId: ORG_B } }), 0);
  });

  test('the fuzzy raw query never sees another org — it is scoped by hand', async () => {
    // ORG_A has "Sharma Electricals" in Solapur (above). ORG_B must not find it.
    const row = normalizeRow(
      { N: 'Sharma Electrical', C: 'Solapur' },
      { businessName: 'N', city: 'C' },
    );
    const inB = await runWithOrg(ORG_B, () => dedup.findMatch(row));
    assert.equal(inB, null);

    const inA = await runWithOrg(ORG_A, () => dedup.findMatch(row));
    assert.equal(inA?.reason, 'FUZZY_NAME_CITY');
    assert.equal(inA?.confirmed, false);
  });

  test('the fuzzy query refuses to run with no org context at all', async () => {
    const row = normalizeRow(
      { N: 'Sharma Electrical', C: 'Solapur' },
      { businessName: 'N', city: 'C' },
    );
    await assert.rejects(() => dedup.findMatch(row), /tenancy/i);
  });

  test("another org's import batch cannot be run", async () => {
    const preview = await runWithOrg(ORG_A, () =>
      imports.startBatch({
        filename: 'dealers.csv',
        buffer: file('Leak Co,Ravi,9876600002,leak@test.local,Pune\n'),
        source: 'IMPORTED_LIST' as never,
      }),
    );
    await runWithOrg(ORG_B, async () => {
      await assert.rejects(
        () => imports.runBatch(preview.batchId, file('x\n'), MAPPING as never),
        /not found/i,
      );
    });
  });
});
