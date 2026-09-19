// M4 (§5.4) — DB-backed: what logging a call does, and that a brief never lets a model
// state a number (§1.4). The pure rules are in rules.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { CallService } from '../../src/modules/calling/call.service';
import { BriefService } from '../../src/modules/calling/brief.service';
import { SyncService } from '../../src/modules/sync';
// ---- database-backed ---------------------------------------------------------------------

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;
const calls = new CallService(db, new AuditService(db));

const ORG = 'call-org-a';
const ORG_B = 'call-org-b';
const USER = 'call-user-a';
let n = 0;

async function makeDealer(orgId: string, name: string, stage: 'NEW' | 'CONTACTED' | 'INTERESTED' | 'ACTIVE' = 'NEW') {
  const phone = `+9198000${String(10000 + n++)}`;
  return raw.dealer.create({
    data: { organizationId: orgId, businessName: name, source: 'MANUAL', pipelineStage: stage, phones: { create: [{ raw: phone, e164: phone, valid: true, isPrimary: true }] } },
    include: { phones: true },
  });
}
const log = (dealerId: string, outcome: any, extra: object = {}) =>
  runWithOrg(ORG, () => calls.log({ dealerId, outcome, userId: USER, ...extra }));

before(async () => {
  await raw.organization.createMany({ data: [{ id: ORG, name: 'Call A', slug: ORG }, { id: ORG_B, name: 'Call B', slug: ORG_B }] });
  await raw.user.create({ data: { id: USER, organizationId: ORG, email: 'caller@test.local', passwordHash: 'x', role: 'OWNER' } });
});
after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('logging a call (§5.4)', () => {
  test('an onboarding call walks NEW → CONTACTED → INTERESTED → ONBOARDED, one audit row per step', async () => {
    const d = await makeDealer(ORG, 'Onboard Me');
    await log(d.id, 'ONBOARDED', { notes: 'agreed terms' });

    assert.equal((await raw.dealer.findUniqueOrThrow({ where: { id: d.id } })).pipelineStage, 'ONBOARDED');
    assert.equal(await raw.auditEvent.count({ where: { entityId: d.id, action: 'PIPELINE_STAGE_CHANGED' } }), 3);
    const ev = await raw.interactionEvent.findFirstOrThrow({ where: { dealerId: d.id, channel: 'CALL' } });
    assert.equal(ev.direction, 'OUTBOUND');
    assert.match(ev.body, /onboarded — agreed terms/);
  });

  test('a call never demotes a dealer who is already further along', async () => {
    const d = await makeDealer(ORG, 'Already Active', 'ACTIVE');
    await log(d.id, 'SPOKE_NOT_INTERESTED');
    assert.equal((await raw.dealer.findUniqueOrThrow({ where: { id: d.id } })).pipelineStage, 'ACTIVE');
    assert.equal(await raw.auditEvent.count({ where: { entityId: d.id, action: 'PIPELINE_STAGE_CHANGED' } }), 0);
  });

  test('no answer records the attempt and moves nothing', async () => {
    const d = await makeDealer(ORG, 'No Answer Co');
    await log(d.id, 'NO_ANSWER');
    assert.equal((await raw.dealer.findUniqueOrThrow({ where: { id: d.id } })).pipelineStage, 'NEW');
    assert.equal((await raw.interactionEvent.findFirstOrThrow({ where: { dealerId: d.id, channel: 'CALL' } })).status, 'FAILED');
  });

  test('do-not-call writes an append-only CALL opt-out and drops them from the queue', async () => {
    const d = await makeDealer(ORG, 'No Calls Please', 'INTERESTED');
    assert.ok((await runWithOrg(ORG, () => calls.queue())).some((q) => q.dealerId === d.id), 'interested dealers are queued');

    await log(d.id, 'DO_NOT_CALL');

    const rows = await raw.consentLog.findMany({ where: { dealerId: d.id, channel: 'CALL' } });
    assert.equal(rows.at(-1)!.state, 'OPTED_OUT');
    assert.equal(rows.at(-1)!.source, 'VERBAL');
    assert.ok(!(await runWithOrg(ORG, () => calls.queue())).some((q) => q.dealerId === d.id));
    // …and other channels are untouched (consent is per channel).
    assert.equal(await raw.consentLog.count({ where: { dealerId: d.id, channel: 'EMAIL', state: 'OPTED_OUT' } }), 0);
  });

  test('a wrong number marks that number invalid', async () => {
    const d = await makeDealer(ORG, 'Wrong Number Ltd');
    await log(d.id, 'WRONG_NUMBER');
    assert.equal((await raw.dealerPhone.findFirstOrThrow({ where: { dealerId: d.id } })).valid, false);
  });

  test('a promised call-back shows in follow-ups and is closed by the next call', async () => {
    const d = await makeDealer(ORG, 'Call Me Back');
    const first = await log(d.id, 'SPOKE_CALL_BACK', { followUpAt: new Date(Date.now() - 3_600_000).toISOString() });
    assert.ok((await runWithOrg(ORG, () => calls.followUps())).some((f) => f.id === first.id));
    assert.equal((await runWithOrg(ORG, () => calls.queue())).find((q) => q.dealerId === d.id)?.reason, 'Call-back promised');

    await log(d.id, 'SPOKE_INTERESTED');
    assert.equal((await raw.callLog.findUniqueOrThrow({ where: { id: first.id } })).followUpDone, true);
  });

  test('an unknown dealer or a garbage date is a clean error', async () => {
    await assert.rejects(() => log('nope', 'NO_ANSWER'), /no dealer/);
    const d = await makeDealer(ORG, 'Bad Date');
    await assert.rejects(() => log(d.id, 'SPOKE_CALL_BACK', { followUpAt: 'not-a-date' }), /not a valid date/);
  });

  test('another org’s dealers cannot be logged against or listed', async () => {
    const other = await makeDealer(ORG_B, 'Other Org Dealer', 'INTERESTED');
    await assert.rejects(() => log(other.id, 'NO_ANSWER'), /no dealer/);
    assert.ok(!(await runWithOrg(ORG, () => calls.queue())).some((q) => q.dealerId === other.id));
    await assert.rejects(() => db.callLog.findMany(), /no org context/);
  });
});

describe('the brief (§1.4)', () => {
  const brief = (ai: { complete: () => Promise<string> }, dealerId: string) =>
    runWithOrg(ORG, () => new BriefService(db, ai as never, new SyncService(db)).brief(dealerId));

  test('money comes from the database; a model that states a figure has its summary withheld', async () => {
    const d = await makeDealer(ORG, 'Brief Traders');
    await raw.interactionEvent.create({ data: { organizationId: ORG, dealerId: d.id, channel: 'EMAIL', direction: 'INBOUND', status: 'REPLIED', body: 'Please send rates for 4 cameras' } });
    await raw.order.create({ data: { organizationId: ORG, dealerId: d.id, orderDate: new Date(), totalValue: 125000, source: 'MANUAL' } });
    await raw.paymentLedgerEntry.create({ data: { organizationId: ORG, dealerId: d.id, invoiceRef: 'BRIEF-1', amount: 50000, paidAmount: 10000, dueDate: new Date(Date.now() - 40 * 86_400_000), lastSyncedAt: new Date(), ageingBucket: 'D30' } });

    const clean = await brief({ complete: async () => '- Asked for rates on cameras\n- Cares about price\n- Offer to send a quote' }, d.id);
    assert.equal(clean.relationship.lifetimeRevenue, '₹1,25,000');
    assert.equal(clean.relationship.outstanding, '₹40,000');
    assert.equal(clean.relationship.overdue, '₹40,000');
    assert.equal(clean.talkingPoints?.length, 3);
    assert.equal(clean.callTo, d.phones[0].e164);

    const tainted = await brief({ complete: async () => '- Offer a 10% discount\n- Mention 4 cameras' }, d.id);
    assert.equal(tainted.talkingPoints, null, 'a figure the model wrote is never shown');
    assert.match(tainted.talkingPointsNote ?? '', /figure/);
    assert.equal(tainted.relationship.outstanding, '₹40,000', 'the database figures are unaffected');
  });

  test('an AI outage does not block the brief', async () => {
    const d = await makeDealer(ORG, 'Brief Outage');
    await raw.interactionEvent.create({ data: { organizationId: ORG, dealerId: d.id, channel: 'WHATSAPP', direction: 'INBOUND', status: 'REPLIED', body: 'hello' } });
    const b = await brief({ complete: async () => { throw new Error('gemini: 503'); } }, d.id);
    assert.equal(b.talkingPoints, null);
    assert.equal(b.timeline.length, 1);
  });

  test('a dealer with no history says so instead of inventing a summary', async () => {
    const d = await makeDealer(ORG, 'Brief Empty');
    let asked = false;
    const b = await brief({ complete: async () => { asked = true; return '- made up'; } }, d.id);
    assert.equal(asked, false, 'the model is not consulted with nothing to summarise');
    assert.match(b.talkingPointsNote ?? '', /No messages/);
  });

  test('a do-not-call dealer is flagged in the brief', async () => {
    const d = await makeDealer(ORG, 'Brief DNC');
    await raw.consentLog.create({ data: { organizationId: ORG, dealerId: d.id, channel: 'CALL', state: 'OPTED_OUT', source: 'VERBAL' } });
    assert.equal((await brief({ complete: async () => '' }, d.id)).doNotCall, true);
  });
});
