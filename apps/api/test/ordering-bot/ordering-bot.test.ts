// M8 (§5.9) — the DB-backed money paths, against the fake WhatsApp provider: nothing without
// enrolment, nothing placed without an explicit CONFIRM, exactly one Order however many
// times CONFIRM arrives, the price the dealer saw is the price charged.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { ApprovalService } from '../../src/core/approval';
import { FakeWhatsAppProvider } from '../../src/providers/whatsapp';
import { WhatsAppSendService } from '../../src/modules/outreach-whatsapp/whatsapp-send.service';
import { InboundBotRegistry } from '../../src/modules/outreach-whatsapp/inbound-bot.registry';
import { ORDERING_BOT_RULE_ID, OrderingBotService } from '../../src/modules/ordering-bot/ordering-bot.service';

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;
const fake = new FakeWhatsAppProvider();
const audit = new AuditService(db);
const approval = new ApprovalService(db, audit, [{ id: ORDERING_BOT_RULE_ID, sourceModule: 'outreach-whatsapp' }]);
const sender = new WhatsAppSendService(db, fake, { isPaused: async () => false } as never);
const bot = new OrderingBotService(db, new InboundBotRegistry(), approval, sender, audit);

const ORG = 'bot-org-a';
const ORG_OTHER = 'bot-org-b';
let n = 0;

async function makeDealer(orgId: string, enrolled: boolean) {
  const phone = `+1555556${String(1000 + n++)}`;
  const dealer = await raw.dealer.create({
    data: {
      organizationId: orgId,
      businessName: `Bot Dealer ${n}`,
      source: 'IMPORTED_LIST',
      pipelineStage: 'ONBOARDED',
      phones: { create: [{ raw: phone, e164: phone, valid: true, isPrimary: true, isWhatsapp: true }] },
    },
  });
  await raw.consentLog.create({ data: { organizationId: orgId, dealerId: dealer.id, channel: 'WHATSAPP', state: 'OPTED_IN', source: 'INBOUND_MESSAGE' } });
  await raw.whatsAppConversation.create({ data: { organizationId: orgId, dealerId: dealer.id, phoneE164: phone, sessionExpiresAt: new Date(Date.now() + 3_600_000) } });
  if (enrolled) await raw.orderingBotPilot.create({ data: { organizationId: orgId, dealerId: dealer.id } });
  return dealer;
}

const say = (orgId: string, dealerId: string, text: string) => runWithOrg(orgId, () => bot.handle({ dealerId, text }));
const lastReply = () => fake.freeform[fake.freeform.length - 1]?.text ?? '';

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG, name: 'Bot Org A', slug: ORG },
      { id: ORG_OTHER, name: 'Bot Org B', slug: ORG_OTHER },
    ],
  });
  await raw.orderingBotSettings.create({ data: { organizationId: ORG, enabled: true, maxLineQuantity: 500, pilotLimit: 1000 } });
  await raw.product.createMany({
    data: [
      { organizationId: ORG, sku: 'A1', name: 'Widget', unitPrice: '120.50' },
      { organizationId: ORG, sku: 'B2', name: 'Gadget', unitPrice: '99.99' },
    ],
  });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('who the bot talks to', () => {
  test('a dealer who is not in the pilot is left to the human inbox', async () => {
    const d = await makeDealer(ORG, false);
    const sent = fake.freeform.length;
    assert.deepEqual(await say(ORG, d.id, 'A1 x 10'), { handled: false });
    assert.equal(fake.freeform.length, sent);
  });

  test('switched off, nobody is answered even if enrolled', async () => {
    await raw.organization.create({ data: { id: 'bot-off', name: 'Off', slug: 'bot-off' } });
    await raw.orderingBotSettings.create({ data: { organizationId: 'bot-off', enabled: false } });
    const d = await makeDealer('bot-off', true);
    assert.deepEqual(await say('bot-off', d.id, 'hello'), { handled: false });
  });

  test('the pilot is capped', async () => {
    await raw.organization.create({ data: { id: 'bot-cap', name: 'Cap', slug: 'bot-cap' } });
    await raw.orderingBotSettings.create({ data: { organizationId: 'bot-cap', enabled: true, pilotLimit: 1 } });
    const a = await makeDealer('bot-cap', false);
    const b = await makeDealer('bot-cap', false);
    await runWithOrg('bot-cap', () => bot.enroll(a.id));
    await assert.rejects(() => runWithOrg('bot-cap', () => bot.enroll(b.id)), /capped at 1/);
  });
});

describe('placing an order', () => {
  test('a list is echoed back with DB prices and the total, and places nothing yet', async () => {
    const d = await makeDealer(ORG, true);
    const r = await say(ORG, d.id, 'A1 x 10, B2 x 3');
    assert.equal(r.handled, true);
    assert.match(lastReply(), /Total: ₹1,504\.97/);
    assert.match(lastReply(), /CONFIRM/);
    assert.match(lastReply(), /HUMAN/);
    assert.equal(await raw.order.count({ where: { dealerId: d.id } }), 0, 'no order before CONFIRM');
    assert.equal(await raw.botOrderDraft.count({ where: { dealerId: d.id, status: 'OPEN' } }), 1);
  });

  test('"ok" does not confirm; CONFIRM does, exactly once however often it arrives', async () => {
    const d = await makeDealer(ORG, true);
    await say(ORG, d.id, 'A1 x 2');
    assert.deepEqual(await say(ORG, d.id, 'ok'), { handled: false });
    assert.equal(await raw.order.count({ where: { dealerId: d.id } }), 0);

    await Promise.all([say(ORG, d.id, 'CONFIRM'), say(ORG, d.id, 'CONFIRM')]);
    await say(ORG, d.id, 'CONFIRM');
    const orders = await raw.order.findMany({ where: { dealerId: d.id }, include: { lineItems: true } });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].source, 'ORDERING_BOT');
    assert.equal(Number(orders[0].totalValue), 241);
    assert.equal(orders[0].lineItems[0].sku, 'A1');
  });

  test('a misparsed or oversized quantity never becomes an order', async () => {
    const d = await makeDealer(ORG, true);
    const r = await say(ORG, d.id, 'A1 x 5000');
    assert.equal(r.needsHuman, true);
    assert.equal(await raw.botOrderDraft.count({ where: { dealerId: d.id } }), 0);
    await say(ORG, d.id, 'A1 x 10, Z9 x 2');
    assert.match(lastReply(), /could not read/);
    assert.equal(await raw.botOrderDraft.count({ where: { dealerId: d.id } }), 0);
  });

  test('if the price moved after the dealer saw it, CONFIRM re-shows instead of charging', async () => {
    const d = await makeDealer(ORG, true);
    await say(ORG, d.id, 'B2 x 1');
    await raw.product.updateMany({ where: { organizationId: ORG, sku: 'B2' }, data: { unitPrice: '105.00' } });
    await say(ORG, d.id, 'CONFIRM');
    assert.equal(await raw.order.count({ where: { dealerId: d.id } }), 0);
    assert.match(lastReply(), /changed/);
    assert.match(lastReply(), /₹105/);
    await say(ORG, d.id, 'CONFIRM');
    assert.equal(Number((await raw.order.findFirstOrThrow({ where: { dealerId: d.id } })).totalValue), 105);
    await raw.product.updateMany({ where: { organizationId: ORG, sku: 'B2' }, data: { unitPrice: '99.99' } });
  });

  test('an unconfirmed order expires', async () => {
    const d = await makeDealer(ORG, true);
    await say(ORG, d.id, 'A1 x 1');
    await raw.botOrderDraft.updateMany({ where: { dealerId: d.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await say(ORG, d.id, 'CONFIRM');
    assert.equal(await raw.order.count({ where: { dealerId: d.id } }), 0);
  });

  test('HUMAN always works and escalates', async () => {
    const d = await makeDealer(ORG, true);
    const r = await say(ORG, d.id, 'I want to talk to a person');
    assert.equal(r.needsHuman, true);
  });

  test('a confirmed order lands in the same Order table as imports, in its own org, and activates the dealer', async () => {
    const d = await makeDealer(ORG, true);
    await say(ORG, d.id, 'A1 x 1');
    await say(ORG, d.id, 'CONFIRM');
    assert.equal(await raw.order.count({ where: { organizationId: ORG_OTHER } }), 0);
    assert.equal((await raw.dealer.findFirstOrThrow({ where: { id: d.id } })).pipelineStage, 'ACTIVE');
  });
});
