// §10.2 / §13 — consent precedence and channel independence, the money paths for
// "who may we email". Real Postgres, no mocks.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { currentConsentState, isEligibleForEmail, writeConsent } from '../../src/modules/outreach-email/consent';
import { eligibleForColdOutreach } from '../../src/modules/outreach-email/eligibility';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());

const ORG_A = 'consent-org-a';
const ORG_B = 'consent-org-b';
const D1 = 'consent-dealer-1'; // no consent rows at all
const D2 = 'consent-dealer-2'; // opted out on EMAIL, opted in on WHATSAPP
const D3 = 'consent-dealer-3'; // opted in, then opted out — most recent wins
const D4 = 'consent-dealer-4'; // opted out, then opted back in — most recent wins
const D5 = 'consent-dealer-5'; // NOT pipelineStage NEW — must never be selected
const DB1 = 'consent-dealer-b1';

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Consent A', slug: ORG_A },
      { id: ORG_B, name: 'Consent B', slug: ORG_B },
    ],
  });
  await raw.dealer.createMany({
    data: [
      { id: D1, organizationId: ORG_A, businessName: 'D1', source: 'MANUAL', pipelineStage: 'NEW' },
      { id: D2, organizationId: ORG_A, businessName: 'D2', source: 'MANUAL', pipelineStage: 'NEW' },
      { id: D3, organizationId: ORG_A, businessName: 'D3', source: 'MANUAL', pipelineStage: 'NEW' },
      { id: D4, organizationId: ORG_A, businessName: 'D4', source: 'MANUAL', pipelineStage: 'NEW' },
      { id: D5, organizationId: ORG_A, businessName: 'D5', source: 'MANUAL', pipelineStage: 'CONTACTED' },
      { id: DB1, organizationId: ORG_B, businessName: 'DB1', source: 'MANUAL', pipelineStage: 'NEW' },
    ],
  });

  const t = (ms: number) => new Date(Date.now() - ms);
  await raw.consentLog.createMany({
    data: [
      { organizationId: ORG_A, dealerId: D2, channel: 'EMAIL', state: 'OPTED_OUT', source: 'EXPLICIT_UNSUBSCRIBE', createdAt: t(0) },
      { organizationId: ORG_A, dealerId: D2, channel: 'WHATSAPP', state: 'OPTED_IN', source: 'VERBAL', createdAt: t(0) },

      { organizationId: ORG_A, dealerId: D3, channel: 'EMAIL', state: 'OPTED_IN', source: 'INBOUND_MESSAGE', createdAt: t(10_000) },
      { organizationId: ORG_A, dealerId: D3, channel: 'EMAIL', state: 'OPTED_OUT', source: 'EXPLICIT_UNSUBSCRIBE', createdAt: t(0) },

      { organizationId: ORG_A, dealerId: D4, channel: 'EMAIL', state: 'OPTED_OUT', source: 'BOUNCE', createdAt: t(10_000) },
      { organizationId: ORG_A, dealerId: D4, channel: 'EMAIL', state: 'OPTED_IN', source: 'INBOUND_MESSAGE', createdAt: t(0) },
    ],
  });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('§10.2 — most recent ConsentLog row per (dealer, channel) wins', () => {
  test('no row at all is not opted out', async () => {
    const state = await runWithOrg(ORG_A, () => currentConsentState(scoped as unknown as PrismaClient, D1, 'EMAIL'));
    assert.equal(state, null);
    assert.equal(isEligibleForEmail(state), true);
  });

  test('an EMAIL opt-out does not suppress WHATSAPP — channels are independent', async () => {
    const email = await runWithOrg(ORG_A, () => currentConsentState(scoped as unknown as PrismaClient, D2, 'EMAIL'));
    const wa = await runWithOrg(ORG_A, () => currentConsentState(scoped as unknown as PrismaClient, D2, 'WHATSAPP'));
    assert.equal(email, 'OPTED_OUT');
    assert.equal(wa, 'OPTED_IN');
  });

  test('opted in then opted out — the later row (OPTED_OUT) wins, not insertion order', async () => {
    const state = await runWithOrg(ORG_A, () => currentConsentState(scoped as unknown as PrismaClient, D3, 'EMAIL'));
    assert.equal(state, 'OPTED_OUT');
  });

  test('opted out then opted back in — the later row (OPTED_IN) wins', async () => {
    const state = await runWithOrg(ORG_A, () => currentConsentState(scoped as unknown as PrismaClient, D4, 'EMAIL'));
    assert.equal(state, 'OPTED_IN');
  });
});

describe('§5.2 — cold outreach eligibility', () => {
  test('selects only NEW dealers whose current EMAIL consent is not OPTED_OUT, org-scoped', async () => {
    const dealers = await runWithOrg(ORG_A, () => eligibleForColdOutreach(scoped as unknown as PrismaClient));
    const ids = dealers.map((d) => d.id).sort();
    // D1 (no rows) and D4 (currently opted in, having been opted out earlier) — yes.
    // D2 and D3 (currently opted out on EMAIL, per the precedence tests above) — no.
    // D5 (not NEW) — no. DB1 (other org) — no.
    assert.deepEqual(ids, [D1, D4].sort());
  });

  test('a dealer with the most recent row OPTED_OUT is never selected, however it got there', async () => {
    const dealers = await runWithOrg(ORG_A, () => eligibleForColdOutreach(scoped as unknown as PrismaClient));
    assert.equal(dealers.some((d) => d.id === D2), false);
  });

  test('org scoping: org A eligibility never includes org B dealers', async () => {
    const dealers = await runWithOrg(ORG_A, () => eligibleForColdOutreach(scoped as unknown as PrismaClient));
    assert.equal(dealers.some((d) => d.id === DB1), false);
    const bDealers = await runWithOrg(ORG_B, () => eligibleForColdOutreach(scoped as unknown as PrismaClient));
    assert.deepEqual(bDealers.map((d) => d.id), [DB1]);
  });
});

describe('§1.3 — no context, no query', () => {
  test('eligibleForColdOutreach without a context throws rather than leaking', async () => {
    await assert.rejects(eligibleForColdOutreach(scoped as unknown as PrismaClient), /tenancy/i);
  });
});

describe('writeConsent is append-only and org-scoped by the tenancy client', () => {
  test('two writes to the same channel both persist — nothing is updated in place', async () => {
    const dealerId = 'consent-append-dealer';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG_A, businessName: 'Append Co', source: 'MANUAL' } });
    await runWithOrg(ORG_A, async () => {
      await writeConsent(scoped as unknown as PrismaClient, { organizationId: ORG_A, dealerId, channel: 'EMAIL', state: 'OPTED_IN', source: 'VERBAL' });
      await writeConsent(scoped as unknown as PrismaClient, { organizationId: ORG_A, dealerId, channel: 'EMAIL', state: 'OPTED_OUT', source: 'EXPLICIT_UNSUBSCRIBE' });
    });
    const rows = await raw.consentLog.findMany({ where: { dealerId, channel: 'EMAIL' } });
    assert.equal(rows.length, 2);
  });
});
