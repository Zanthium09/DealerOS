// M5 (§5.6) — the scan, against a real database: who goes dormant, who is nudged and how,
// who is reactivated (and whether the nudge is credited), and that a repeat scan is a no-op.
// The pure thresholds are in rules.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { ApprovalService } from '../../src/core/approval';
import { AuditService } from '../../src/core/audit';
import { DraftingService } from '../../src/core/drafting';
import { FakeAIProvider } from '../../src/providers/ai';
import { DormancyService } from '../../src/modules/dormancy/dormancy.service';

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;
const audit = new AuditService(db);
const RULES = [{ id: 'dormancy-nudge-no-money', sourceModule: 'dormancy' }];
// The default echo returns only the last LINE of the prompt; the nudge skeleton is
// multi-line, so echo everything after "Skeleton:" — what a well-behaved model returns.
const ai = new FakeAIProvider((p) => p.prompt.split('Skeleton:\n')[1] ?? '');
const emailSent: string[] = [];
const emailStub = { sendApprovedDraft: async (id: string) => (emailSent.push(id), { id: `evt-${id}` }) } as never;
const service = new DormancyService(db, new DraftingService(db, ai, RULES), new ApprovalService(db, audit, RULES), audit, emailStub);

const DAY = 86_400_000;
let n = 0;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** A fresh org per test so one scan's effects never leak into another's assertions. */
async function freshOrg(settings: { enabled?: boolean; thresholdDays?: number; autoSendBelowAov?: number | null } = {}) {
  const id = `dorm-org-${n++}`;
  await raw.organization.create({ data: { id, name: `Dorm ${id}`, slug: id } });
  await raw.dormancySettings.create({ data: { organizationId: id, enabled: true, thresholdDays: 30, autoSendBelowAov: 10_000, ...settings } as never });
  return id;
}

async function dealer(
  org: string,
  name: string,
  opts: { stage: 'ONBOARDED' | 'ACTIVE' | 'DORMANT' | 'REACTIVATED'; orders?: { daysAgo: number; value: number }[]; email?: string | null; emailOptOut?: boolean },
) {
  const d = await raw.dealer.create({
    data: {
      organizationId: org,
      businessName: name,
      contactPersonName: 'Asha',
      source: 'MANUAL',
      pipelineStage: opts.stage,
      emails: opts.email === null ? undefined : { create: [{ address: opts.email ?? `${name.replace(/\W/g, '').toLowerCase()}@test.local`, isPrimary: true }] },
    },
  });
  for (const o of opts.orders ?? []) {
    await raw.order.create({ data: { organizationId: org, dealerId: d.id, orderDate: ago(o.daysAgo), totalValue: o.value, source: 'MANUAL' } });
  }
  if (opts.emailOptOut) await raw.consentLog.create({ data: { organizationId: org, dealerId: d.id, channel: 'EMAIL', state: 'OPTED_OUT', source: 'EXPLICIT_UNSUBSCRIBE' } });
  return d;
}

const scan = (org: string, opts: { dryRun?: boolean; now?: Date } = {}) => runWithOrg(org, () => service.scan(opts));
const stageOf = async (id: string) => (await raw.dealer.findUniqueOrThrow({ where: { id } })).pipelineStage;
const drafts = (dealerId: string) => raw.messageDraft.findMany({ where: { dealerId, sourceModule: 'dormancy' } });

before(() => {
  emailSent.length = 0;
});
after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('going dormant', () => {
  test('an ACTIVE dealer with no order in N days becomes DORMANT, audited; a recent one does not', async () => {
    const org = await freshOrg();
    const stale = await dealer(org, 'Stale Traders', { stage: 'ACTIVE', orders: [{ daysAgo: 45, value: 5_000 }] });
    const fresh = await dealer(org, 'Fresh Traders', { stage: 'ACTIVE', orders: [{ daysAgo: 10, value: 5_000 }] });

    const r = await scan(org);

    assert.equal(await stageOf(stale.id), 'DORMANT');
    assert.equal(await stageOf(fresh.id), 'ACTIVE');
    assert.deepEqual(r.wentDormant.map((w) => w.dealerId), [stale.id]);
    const audits = await raw.auditEvent.findMany({ where: { entityId: stale.id, action: 'PIPELINE_STAGE_CHANGED' } });
    assert.equal(audits.length, 1);
    assert.match((audits[0].metadata as any).reason, /No order in 45 days/);
  });

  test('the threshold boundary is exact and configurable', async () => {
    const org = await freshOrg({ thresholdDays: 30 });
    const at30 = await dealer(org, 'Exactly Thirty', { stage: 'ACTIVE', orders: [{ daysAgo: 30, value: 1 }] });
    const at29 = await dealer(org, 'Twenty Nine', { stage: 'ACTIVE', orders: [{ daysAgo: 29, value: 1 }] });
    await scan(org);
    assert.equal(await stageOf(at30.id), 'DORMANT');
    assert.equal(await stageOf(at29.id), 'ACTIVE');

    const org2 = await freshOrg({ thresholdDays: 60 });
    const at45 = await dealer(org2, 'Forty Five', { stage: 'ACTIVE', orders: [{ daysAgo: 45, value: 1 }] });
    await scan(org2);
    assert.equal(await stageOf(at45.id), 'ACTIVE');
  });

  test('a dealer with no orders on record is left alone and counted — never invented as dormant', async () => {
    const org = await freshOrg();
    const none = await dealer(org, 'No Orders Yet', { stage: 'ACTIVE' });
    const r = await scan(org);
    assert.equal(await stageOf(none.id), 'ACTIVE');
    assert.equal(r.noOrderHistory, 1);
  });

  test('a REACTIVATED dealer who lapses again goes back to DORMANT', async () => {
    const org = await freshOrg();
    const d = await dealer(org, 'Lapsed Again', { stage: 'REACTIVATED', orders: [{ daysAgo: 50, value: 1 }] });
    await scan(org);
    assert.equal(await stageOf(d.id), 'DORMANT');
  });

  test('a dry run reports what it would do and changes nothing', async () => {
    const org = await freshOrg();
    const stale = await dealer(org, 'Dry Run Co', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 1 }] });
    const r = await scan(org, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.wentDormant.length, 1);
    assert.equal(await stageOf(stale.id), 'ACTIVE');
    assert.equal((await drafts(stale.id)).length, 0);
    assert.equal(await raw.auditEvent.count({ where: { entityId: stale.id } }), 0);
  });
});

describe('the nudge (§5.6)', () => {
  test('below the value threshold it auto-sends through the shared email sender', async () => {
    const org = await freshOrg({ autoSendBelowAov: 10_000 });
    const low = await dealer(org, 'Low Value Co', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 2_000 }, { daysAgo: 90, value: 4_000 }] });
    const before = emailSent.length;

    const r = await scan(org);

    assert.equal(r.wentDormant[0].nudge, 'auto-sent');
    const [draft] = await drafts(low.id);
    assert.equal(draft.requiresApproval, false);
    assert.equal(draft.status, 'APPROVED');
    assert.equal(draft.subject, 'Checking in, Low Value Co');
    assert.match(draft.draftText, /Hi Asha,/);
    assert.match(draft.draftText, /Low Value Co/);
    assert.equal(emailSent.length, before + 1);
    // An auto-send is audited under the rule that fired, with no human credited (§9).
    const a = await raw.auditEvent.findFirstOrThrow({ where: { entityId: draft.id, action: 'DRAFT_AUTO_SENT' } });
    assert.equal(a.actorType, 'SYSTEM');
  });

  test('above the threshold — or with none configured — it waits in the queue for a person', async () => {
    const org = await freshOrg({ autoSendBelowAov: 10_000 });
    const big = await dealer(org, 'Big Buyer', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 80_000 }] });
    const before = emailSent.length;
    const r = await scan(org);
    assert.equal(r.wentDormant[0].nudge, 'queued');
    const [draft] = await drafts(big.id);
    assert.equal(draft.status, 'PENDING');
    assert.equal(draft.requiresApproval, true);
    assert.equal(draft.autoSendRuleId, null);
    assert.equal(emailSent.length, before, 'nothing was sent');

    const org2 = await freshOrg({ autoSendBelowAov: null });
    const small = await dealer(org2, 'Small Buyer', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 100 }] });
    await scan(org2);
    assert.equal((await drafts(small.id))[0].status, 'PENDING', 'with no threshold nothing auto-sends');
  });

  test('a dealer we must not or cannot email still goes dormant, with the reason recorded', async () => {
    const org = await freshOrg();
    const optedOut = await dealer(org, 'Opted Out Co', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 100 }], emailOptOut: true });
    const junk = await dealer(org, 'Junk Address Co', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 100 }], email: 'microdots' });
    const noEmail = await dealer(org, 'No Email Co', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 100 }], email: null });
    const r = await scan(org);
    for (const d of [optedOut, junk, noEmail]) assert.equal(await stageOf(d.id), 'DORMANT');
    const byName = Object.fromEntries(r.wentDormant.map((w) => [w.businessName, w.nudge]));
    assert.match(byName['Opted Out Co'], /opted out/);
    assert.match(byName['Junk Address Co'], /no usable email/);
    assert.match(byName['No Email Co'], /no usable email/);
    for (const d of [optedOut, junk, noEmail]) assert.equal((await drafts(d.id)).length, 0);
  });

  test('a repeat scan changes nothing: no second transition, no second nudge', async () => {
    const org = await freshOrg();
    const d = await dealer(org, 'Once Only', { stage: 'ACTIVE', orders: [{ daysAgo: 60, value: 100 }] });
    await scan(org);
    const r2 = await scan(org);
    assert.equal(r2.wentDormant.length, 0);
    assert.equal((await drafts(d.id)).length, 1);
    assert.equal(await raw.auditEvent.count({ where: { entityId: d.id, action: 'PIPELINE_STAGE_CHANGED' } }), 1);
  });
});

describe('reactivation (§5.6)', () => {
  test('a dormant dealer who ordered after our nudge is REACTIVATED and the nudge is credited', async () => {
    const org = await freshOrg();
    const d = await dealer(org, 'Came Back', { stage: 'DORMANT', orders: [{ daysAgo: 5, value: 9_000 }] });
    await raw.messageDraft.create({ data: { organizationId: org, dealerId: d.id, sourceModule: 'dormancy', draftText: 'nudge', status: 'AUTO_SENT', sentAt: ago(12) } });

    const r = await scan(org);

    assert.equal(await stageOf(d.id), 'REACTIVATED');
    assert.deepEqual(r.reactivated, [{ dealerId: d.id, businessName: 'Came Back', creditedToNudge: true }]);
    const a = await raw.auditEvent.findFirstOrThrow({ where: { entityId: d.id, action: 'PIPELINE_STAGE_CHANGED' } });
    assert.match((a.metadata as any).reason, /after our nudge/);
  });

  test('an order with no nudge behind it reactivates the dealer but takes no credit', async () => {
    const org = await freshOrg();
    const d = await dealer(org, 'Came Back Alone', { stage: 'DORMANT', orders: [{ daysAgo: 5, value: 9_000 }] });
    const r = await scan(org);
    assert.equal(await stageOf(d.id), 'REACTIVATED');
    assert.equal(r.reactivated[0].creditedToNudge, false);
  });

  test('an order that predates the nudge is not credited to it', async () => {
    const org = await freshOrg();
    const d = await dealer(org, 'Order Before Nudge', { stage: 'DORMANT', orders: [{ daysAgo: 10, value: 1 }] });
    await raw.messageDraft.create({ data: { organizationId: org, dealerId: d.id, sourceModule: 'dormancy', draftText: 'nudge', status: 'AUTO_SENT', sentAt: ago(3) } });
    const r = await scan(org);
    assert.equal(r.reactivated[0].creditedToNudge, false);
  });

  test('a dormant dealer who has still not ordered stays dormant', async () => {
    const org = await freshOrg();
    const d = await dealer(org, 'Still Quiet', { stage: 'DORMANT', orders: [{ daysAgo: 90, value: 1 }] });
    await scan(org);
    assert.equal(await stageOf(d.id), 'DORMANT');
  });

  test('ONBOARDED → ACTIVE on the first order; without one, they wait', async () => {
    const org = await freshOrg();
    const ordered = await dealer(org, 'First Order', { stage: 'ONBOARDED', orders: [{ daysAgo: 2, value: 1 }] });
    const waiting = await dealer(org, 'Not Yet', { stage: 'ONBOARDED' });
    const r = await scan(org);
    assert.equal(await stageOf(ordered.id), 'ACTIVE');
    assert.equal(await stageOf(waiting.id), 'ONBOARDED');
    assert.equal(r.activated, 1);
  });
});

describe('overview, settings and scoping', () => {
  test('the overview reports the dormant baseline and credited reactivations', async () => {
    const org = await freshOrg();
    await dealer(org, 'Baseline A', { stage: 'DORMANT', orders: [{ daysAgo: 90, value: 10_000 }] });
    await dealer(org, 'Baseline B', { stage: 'DORMANT', orders: [{ daysAgo: 100, value: 30_000 }] });
    const o = await runWithOrg(org, () => service.overview());
    assert.equal(o.dormantCount, 2);
    assert.equal(o.averageHistoricalOrderValue, 20_000);
    assert.equal(o.dormant[0].businessName, 'Baseline B', 'highest-value dormant dealers first');
  });

  test('settings are validated', async () => {
    const org = await freshOrg();
    await assert.rejects(() => runWithOrg(org, () => service.updateSettings({ thresholdDays: 0 })), /at least 1/);
    await assert.rejects(() => runWithOrg(org, () => service.updateSettings({ thresholdDays: 2.5 })), /whole number/);
    await assert.rejects(() => runWithOrg(org, () => service.updateSettings({ autoSendBelowAov: -1 })), /negative/);
    const s = await runWithOrg(org, () => service.updateSettings({ thresholdDays: 45, autoSendBelowAov: null }));
    assert.equal(s.thresholdDays, 45);
    assert.equal(s.autoSendBelowAov, null);
  });

  test('a scan only ever sees its own organization', async () => {
    const orgA = await freshOrg();
    const orgB = await freshOrg();
    const other = await dealer(orgB, 'Other Org Stale', { stage: 'ACTIVE', orders: [{ daysAgo: 90, value: 1 }] });
    const r = await scan(orgA);
    assert.equal(r.wentDormant.length, 0);
    assert.equal(await stageOf(other.id), 'ACTIVE');
    await assert.rejects(() => db.dormancySettings.findMany(), /no org context/);
  });
});
