// M0 (§5.0, design doc §9) — the DB-backed money paths: promotion writes ConsentLog
// UNKNOWN never OPTED_IN, a CONFIRMED_DUPLICATE cannot be promoted (including by direct
// service call), a refused domain never fetches, and both new tables are org-scoped.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { DedupService } from '../../src/modules/contacts/dedup.service';
import { DiscoveryService } from '../../src/modules/lead-discovery/discovery.service';
import { PlacesProvider, RegistryProvider } from '../../src/providers/discovery';

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;

const ORG_A = 'disc-org-a';
const ORG_B = 'disc-org-b';
const USER_A = 'disc-user-a';

// The extractor must never be reached for a refused URL — if it is, the test fails loudly.
const explodingExtraction = {
  run: async () => {
    throw new Error('extraction must not run for a refused domain');
  },
};

const svc = new DiscoveryService(
  db,
  new DedupService(db),
  new AuditService(db),
  { isPaused: async () => false } as never,
  explodingExtraction as never,
  new PlacesProvider(),
  new RegistryProvider(),
);

let n = 0;
async function makeRun(orgId: string) {
  return raw.discoveryRun.create({ data: { organizationId: orgId, method: 'FILE_EXTRACT', query: {}, status: 'COMPLETED' } });
}
async function makeCandidate(orgId: string, runId: string, over: Record<string, unknown> = {}) {
  const i = n++;
  return raw.leadCandidate.create({
    data: {
      organizationId: orgId,
      discoveryRunId: runId,
      businessName: `Lead Traders ${i}`,
      rawPhones: [],
      rawEmails: [`lead${i}-${orgId}@test.local`],
      city: 'Nashik',
      sourceUrl: 'upload:test.csv',
      capturedAt: new Date(),
      ...over,
    },
  });
}

async function waitForRun(runId: string) {
  for (let i = 0; i < 100; i++) {
    const r = await raw.discoveryRun.findUniqueOrThrow({ where: { id: runId } });
    if (r.status !== 'RUNNING') return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('run did not finish');
}

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Disc A', slug: ORG_A },
      { id: ORG_B, name: 'Disc B', slug: ORG_B },
    ],
  });
  await raw.user.create({
    data: { id: USER_A, organizationId: ORG_A, email: 'disc-owner@test.local', passwordHash: 'x', role: 'OWNER' },
  });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('promotion (design doc §7)', () => {
  test('creates a NEW/DISCOVERED dealer, consent UNKNOWN on every channel, and an audit row', async () => {
    const run = await makeRun(ORG_A);
    const cand = await makeCandidate(ORG_A, run.id, { rawPhones: ['98765 43210'], contactPersonName: 'Asha' });

    const { dealerId } = await runWithOrg(ORG_A, () => svc.approve(cand.id, USER_A));

    const dealer = await raw.dealer.findUniqueOrThrow({
      where: { id: dealerId },
      include: { phones: true, emails: true, consentLogs: true },
    });
    assert.equal(dealer.pipelineStage, 'NEW');
    assert.equal(dealer.source, 'DISCOVERED');
    assert.equal(dealer.organizationId, ORG_A);
    assert.equal(dealer.phones.length, 1);
    assert.equal(dealer.emails.length, 1);

    // Discovery is not consent: never OPTED_IN, one UNKNOWN row per channel.
    assert.equal(dealer.consentLogs.length, 3);
    assert.ok(dealer.consentLogs.every((c) => c.state === 'UNKNOWN'));
    assert.ok(!dealer.consentLogs.some((c) => c.state === 'OPTED_IN'));

    const audit = await raw.auditEvent.findFirst({ where: { entityId: dealerId, action: 'LEAD_PROMOTED' } });
    assert.ok(audit, 'promotion must write an AuditEvent');
    assert.equal((audit!.metadata as any).candidateId, cand.id);
    assert.equal((audit!.metadata as any).sourceUrl, 'upload:test.csv');

    const after = await raw.leadCandidate.findUniqueOrThrow({ where: { id: cand.id } });
    assert.equal(after.status, 'APPROVED');
    assert.equal(after.promotedDealerId, dealerId);
  });

  test('a CONFIRMED_DUPLICATE candidate cannot be promoted by a direct service call', async () => {
    const run = await makeRun(ORG_A);
    const existing = await raw.dealer.create({ data: { organizationId: ORG_A, businessName: 'Already Here', source: 'MANUAL' } });
    const cand = await makeCandidate(ORG_A, run.id, {
      dedupeStatus: 'CONFIRMED_DUPLICATE',
      status: 'DUPLICATE',
      matchedDealerId: existing.id,
    });
    const before = await raw.dealer.count({ where: { organizationId: ORG_A } });

    await assert.rejects(() => runWithOrg(ORG_A, () => svc.approve(cand.id, USER_A)));

    assert.equal(await raw.dealer.count({ where: { organizationId: ORG_A } }), before);
    assert.equal((await raw.leadCandidate.findUniqueOrThrow({ where: { id: cand.id } })).promotedDealerId, null);
  });

  test('a candidate that became an exact duplicate since it was found is refused and marked', async () => {
    const run = await makeRun(ORG_A);
    const cand = await makeCandidate(ORG_A, run.id, { rawEmails: ['late-dup@test.local'] });
    // The same business arrives by another route while the candidate sits in the queue.
    await raw.dealer.create({
      data: {
        organizationId: ORG_A,
        businessName: 'Someone Else Entirely',
        source: 'MANUAL',
        emails: { create: [{ address: 'late-dup@test.local', isPrimary: true }] },
      },
    });

    await assert.rejects(() => runWithOrg(ORG_A, () => svc.approve(cand.id, USER_A)), /already|since it was found/);
    const after = await raw.leadCandidate.findUniqueOrThrow({ where: { id: cand.id } });
    assert.equal(after.status, 'DUPLICATE');
    assert.equal(after.promotedDealerId, null);
  });

  test('a candidate can only be decided once', async () => {
    const run = await makeRun(ORG_A);
    const cand = await makeCandidate(ORG_A, run.id);
    await runWithOrg(ORG_A, () => svc.approve(cand.id, USER_A));
    await assert.rejects(() => runWithOrg(ORG_A, () => svc.approve(cand.id, USER_A)), /cannot be decided again/);
    await assert.rejects(() => runWithOrg(ORG_A, () => svc.reject(cand.id, USER_A)), /cannot be decided again/);
  });

  test('reject records the reviewer and creates no dealer', async () => {
    const run = await makeRun(ORG_A);
    const cand = await makeCandidate(ORG_A, run.id);
    const before = await raw.dealer.count({ where: { organizationId: ORG_A } });
    await runWithOrg(ORG_A, () => svc.reject(cand.id, USER_A));
    const after = await raw.leadCandidate.findUniqueOrThrow({ where: { id: cand.id } });
    assert.equal(after.status, 'REJECTED');
    assert.equal(after.reviewedByUserId, USER_A);
    assert.equal(await raw.dealer.count({ where: { organizationId: ORG_A } }), before);
  });
});

describe('runs', () => {
  test('a blocklisted URL is REFUSED immediately and the extractor is never called', async () => {
    const run = await runWithOrg(ORG_A, () => svc.startUrl({ url: 'https://www.indiamart.com/dealers', userId: USER_A }));
    assert.equal(run.status, 'REFUSED');
    assert.equal(run.refusalReason, 'BLOCKLISTED_DOMAIN');
    assert.match(run.error ?? '', /manually/);
    const stored = await raw.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(stored.status, 'REFUSED');
  });

  test('a spreadsheet becomes candidates: provenance kept, in-run duplicates collapsed, existing dealers flagged', async () => {
    await raw.dealer.create({
      data: {
        organizationId: ORG_A,
        businessName: 'Known Dealer',
        source: 'MANUAL',
        emails: { create: [{ address: 'known@test.local', isPrimary: true }] },
      },
    });
    const csv = [
      'Business Name,Email,City',
      'Fresh Traders,fresh@test.local,Pune',
      'Fresh Traders Again,fresh@test.local,Pune', // same email: one shop listed twice
      'Known Dealer Copy,known@test.local,Pune', // exact email match with an existing dealer
    ].join('\n');

    const run = await runWithOrg(ORG_A, () => svc.startFile({ filename: 'leads.csv', buffer: Buffer.from(csv), userId: USER_A }));
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.resultCount, 2);

    const cands = await raw.leadCandidate.findMany({ where: { discoveryRunId: run.id }, orderBy: { businessName: 'asc' } });
    assert.equal(cands.length, 2);
    for (const c of cands) {
      assert.equal(c.sourceUrl, 'upload:leads.csv', 'provenance is never null (§16.2)');
      assert.ok(c.capturedAt);
    }
    const fresh = cands.find((c) => c.businessName === 'Fresh Traders')!;
    const dup = cands.find((c) => c.businessName === 'Known Dealer Copy')!;
    assert.equal(fresh.status, 'PENDING');
    assert.equal(fresh.dedupeStatus, 'UNIQUE');
    assert.equal(dup.status, 'DUPLICATE');
    assert.equal(dup.dedupeStatus, 'CONFIRMED_DUPLICATE');
    assert.ok(dup.matchedDealerId);
  });

  test('Places and registry end FAILED with a reason — never a silently empty queue', async () => {
    const run = await runWithOrg(ORG_A, () => svc.startProvider({ method: 'PLACES_API', query: { city: 'Pune', category: 'CCTV' }, userId: USER_A }));
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'FAILED');
    assert.match(done.error ?? '', /not enabled/);
  });

  test('PDFs and images are refused with an explanation, not silently accepted', async () => {
    await assert.rejects(
      () => runWithOrg(ORG_A, () => svc.startFile({ filename: 'booklet.pdf', buffer: Buffer.from('%PDF'), userId: USER_A })),
      /not enabled/,
    );
  });
});

describe('tenant scoping (§1.3)', () => {
  test("another org's candidates and runs are invisible and cannot be decided", async () => {
    const runB = await makeRun(ORG_B);
    const candB = await makeCandidate(ORG_B, runB.id);

    const seen = await runWithOrg(ORG_A, () => svc.listCandidates({}));
    assert.ok(!seen.some((c) => c.id === candB.id));
    assert.ok(!(await runWithOrg(ORG_A, () => svc.listRuns())).some((r) => r.id === runB.id));
    await assert.rejects(() => runWithOrg(ORG_A, () => svc.approve(candB.id, USER_A)), /no lead candidate/);
    assert.equal((await raw.leadCandidate.findUniqueOrThrow({ where: { id: candB.id } })).status, 'PENDING');
  });

  test('a query without an org context fails instead of leaking', async () => {
    await assert.rejects(() => db.leadCandidate.findMany(), /no org context/);
    await assert.rejects(() => db.discoveryRun.findMany(), /no org context/);
  });
});
