// M3 (§5.3, §7) — the DB-backed money paths, against the fake provider: the send guards
// (warm-routing, 24h window, consent, template approval, quality pause, limits), the
// warm-routing selector, the inbound pipeline, and webhook idempotency / failure recovery.
//
// Phone numbers are +1555… on purpose: outside production the staging guard (§12.7)
// refuses anything that is not a recognised test destination.
import { InboundBotRegistry } from '../../src/modules/outreach-whatsapp/inbound-bot.registry';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { raw } from '../support';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { FakeWhatsAppProvider, fakeSignedWebhook } from '../../src/providers/whatsapp';
import { WhatsAppSendService } from '../../src/modules/outreach-whatsapp/whatsapp-send.service';
import { WhatsAppInboundService } from '../../src/modules/outreach-whatsapp/whatsapp-inbound.service';
import { WhatsAppTemplateService } from '../../src/modules/outreach-whatsapp/template.service';
import { WhatsAppDraftService } from '../../src/modules/outreach-whatsapp/whatsapp-draft.service';
import { eligibleWarmDealers } from '../../src/modules/outreach-whatsapp/eligibility';

const db = withTenancy(new PrismaClient()) as unknown as PrismaClient;
const fake = new FakeWhatsAppProvider();
const killSwitch = { isPaused: async () => false } as never;
const sequenceCancelled: string[] = [];
const sequence = { cancel: async (_o: string, d: string) => void sequenceCancelled.push(d) } as never;

const sender = new WhatsAppSendService(db, fake, killSwitch);
const inbound = new WhatsAppInboundService(db, fake, new AuditService(db), sequence, new InboundBotRegistry());
const templates = new WhatsAppTemplateService(db, fake);
const drafts = new WhatsAppDraftService(db, templates, sender);

const ORG = 'wa-org-a';
const ORG_OTHER = 'wa-org-b';
const ORG_LIMIT = 'wa-org-limit';
const ORG_PAUSED = 'wa-org-paused';
const PN = 'PN-A';

let n = 0;
const nextPhone = () => `+1555555${String(1000 + n++)}`;

async function makeDealer(orgId: string, name: string, opts: { stage?: 'NEW' | 'INTERESTED' | 'ACTIVE'; phone?: string } = {}) {
  const phone = opts.phone ?? nextPhone();
  return raw.dealer.create({
    data: {
      organizationId: orgId,
      businessName: name,
      contactPersonName: 'Asha',
      source: 'IMPORTED_LIST',
      pipelineStage: opts.stage ?? 'NEW',
      phones: { create: [{ raw: phone, e164: phone, valid: true, isPrimary: true }] },
    },
    include: { phones: true },
  });
}

/** The dealer replied to an email — the most common way in. */
const engage = (orgId: string, dealerId: string) =>
  raw.interactionEvent.create({ data: { organizationId: orgId, dealerId, channel: 'EMAIL', direction: 'INBOUND', status: 'REPLIED', body: 'hello' } });

const consent = (orgId: string, dealerId: string, state: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN') =>
  raw.consentLog.create({ data: { organizationId: orgId, dealerId, channel: 'WHATSAPP', state, source: 'IMPORT_DEFAULT' } });

let tplN = 0;
const makeTemplate = (orgId: string, over: Record<string, unknown> = {}) =>
  raw.whatsAppTemplate.create({
    data: { organizationId: orgId, name: `tpl_${tplN++}`, category: 'UTILITY', bodyText: 'Hi {{1}}, a note for {{2}}. Reply for details.', paramKeys: ['contactName', 'businessName'], status: 'APPROVED', ...over } as never,
  });

async function makeDraft(orgId: string, dealerId: string, payload: object, status: 'APPROVED' | 'PENDING' = 'APPROVED') {
  return raw.messageDraft.create({
    data: { organizationId: orgId, dealerId, sourceModule: 'outreach-whatsapp', draftText: 'draft text', templateVariables: payload as never, status, requiresApproval: true },
  });
}

const send = (orgId: string, draftId: string, now?: Date) => runWithOrg(orgId, () => sender.sendApprovedDraft(draftId, now));

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG, name: 'WA Org A', slug: ORG },
      { id: ORG_OTHER, name: 'WA Org B', slug: ORG_OTHER },
      { id: ORG_LIMIT, name: 'WA Limit', slug: ORG_LIMIT },
      { id: ORG_PAUSED, name: 'WA Paused', slug: ORG_PAUSED },
    ],
  });
  await raw.whatsAppAccount.create({ data: { organizationId: ORG, phoneNumberId: PN, wabaId: 'WABA-A' } });
  await raw.outreachSettings.create({ data: { organizationId: ORG_LIMIT, whatsappDailyLimit: 1 } });
  await raw.outreachSettings.create({ data: { organizationId: ORG_PAUSED, whatsappPaused: true } });
});

after(async () => {
  await raw.$disconnect();
  await db.$disconnect();
});

describe('send guards (§1.2, §7)', () => {
  test('a cold dealer cannot be messaged, however the draft got there', async () => {
    const dealer = await makeDealer(ORG, 'Cold Traders');
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    const before = fake.templates.length;

    await assert.rejects(() => send(ORG, draft.id), /has not engaged yet/);

    assert.equal(fake.templates.length, before, 'nothing may reach Meta');
    const failedEvents = await raw.interactionEvent.count({ where: { dealerId: dealer.id, channel: 'WHATSAPP' } });
    assert.equal(failedEvents, 0, 'a refused guard is not a failed send');
  });

  test('a dealer who replied by email is warm: the template goes out with values from the database', async () => {
    const dealer = await makeDealer(ORG, 'Warm Traders');
    await engage(ORG, dealer.id);
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: ['stale', 'stale'] });

    const event = await send(ORG, draft.id);

    const call = fake.templates.at(-1)!;
    assert.equal(call.to, dealer.phones[0].e164);
    assert.equal(call.templateName, tpl.name);
    // Re-derived at send time — the stale values in the draft are not what goes out.
    assert.deepEqual(call.params, ['Asha', 'Warm Traders']);
    assert.equal(event.status, 'SENT');
    assert.equal(event.body, 'Hi Asha, a note for Warm Traders. Reply for details.');
    assert.equal((await raw.messageDraft.findUniqueOrThrow({ where: { id: draft.id } })).status, 'EDITED_AND_SENT');
  });

  test('an opted-out dealer is refused even if otherwise warm', async () => {
    const dealer = await makeDealer(ORG, 'Stopped Traders', { stage: 'ACTIVE' });
    await consent(ORG, dealer.id, 'OPTED_OUT');
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    await assert.rejects(() => send(ORG, draft.id), /opted out/);
  });

  test('consent is latest-wins: opting back in makes them sendable again (§10.2)', async () => {
    const dealer = await makeDealer(ORG, 'Changed Mind');
    await consent(ORG, dealer.id, 'OPTED_OUT');
    await new Promise((r) => setTimeout(r, 5));
    await consent(ORG, dealer.id, 'OPTED_IN');
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    assert.equal((await send(ORG, draft.id)).status, 'SENT');
  });

  test('freeform with no open session is rejected — never quietly downgraded', async () => {
    const dealer = await makeDealer(ORG, 'Window Closed', { stage: 'INTERESTED' });
    const draft = await makeDraft(ORG, dealer.id, { kind: 'freeform', human: true });
    const freeformBefore = fake.freeform.length;
    const templatesBefore = fake.templates.length;
    await assert.rejects(() => send(ORG, draft.id), /24-hour window/);
    assert.equal(fake.freeform.length, freeformBefore);
    assert.equal(fake.templates.length, templatesBefore, 'and no template is sent in its place');
  });

  test('freeform inside an open session is sent', async () => {
    const dealer = await makeDealer(ORG, 'Window Open', { stage: 'INTERESTED' });
    await raw.whatsAppConversation.create({
      data: { organizationId: ORG, dealerId: dealer.id, phoneE164: dealer.phones[0].e164!, sessionExpiresAt: new Date(Date.now() + 3_600_000) },
    });
    const draft = await makeDraft(ORG, dealer.id, { kind: 'freeform', human: true });
    const event = await send(ORG, draft.id);
    assert.equal(event.status, 'SENT');
    assert.equal(fake.freeform.at(-1)!.text, 'draft text');
  });

  test('the window is measured against the clock: the same session is closed a day later', async () => {
    const dealer = await makeDealer(ORG, 'Window Expires', { stage: 'INTERESTED' });
    await raw.whatsAppConversation.create({
      data: { organizationId: ORG, dealerId: dealer.id, phoneE164: dealer.phones[0].e164!, sessionExpiresAt: new Date(Date.now() + 3_600_000) },
    });
    const draft = await makeDraft(ORG, dealer.id, { kind: 'freeform', human: true });
    await assert.rejects(() => send(ORG, draft.id, new Date(Date.now() + 2 * 3_600_000)), /24-hour window/);
  });

  test('a template Meta has not approved cannot be sent', async () => {
    const dealer = await makeDealer(ORG, 'Pending Tpl', { stage: 'ACTIVE' });
    for (const status of ['PENDING', 'REJECTED', 'DRAFT', 'PAUSED'] as const) {
      const tpl = await makeTemplate(ORG, { status });
      const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
      await assert.rejects(() => send(ORG, draft.id), /not APPROVED/, status);
    }
  });

  test('a quality flag pauses MARKETING templates only; utility and live replies still go', async () => {
    await raw.whatsAppAccount.update({ where: { organizationId: ORG }, data: { broadcastsPausedByQuality: true } });
    try {
      const dealer = await makeDealer(ORG, 'Flagged Period', { stage: 'ACTIVE' });
      const marketing = await makeTemplate(ORG, { category: 'MARKETING' });
      const utility = await makeTemplate(ORG, { category: 'UTILITY' });
      const dM = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: marketing.id, params: [] });
      const dU = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: utility.id, params: [] });

      await assert.rejects(() => send(ORG, dM.id), /marketing messages are paused/);
      assert.equal((await send(ORG, dU.id)).status, 'SENT');
    } finally {
      await raw.whatsAppAccount.update({ where: { organizationId: ORG }, data: { broadcastsPausedByQuality: false } });
    }
  });

  test('the org kill switch (§12.6) stops everything', async () => {
    const dealer = await makeDealer(ORG_PAUSED, 'Paused Co', { stage: 'ACTIVE' });
    const tpl = await makeTemplate(ORG_PAUSED);
    const draft = await makeDraft(ORG_PAUSED, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    await assert.rejects(() => send(ORG_PAUSED, draft.id), /paused/);
  });

  test('the daily limit is enforced', async () => {
    const tpl = await makeTemplate(ORG_LIMIT);
    const a = await makeDealer(ORG_LIMIT, 'Limit One', { stage: 'ACTIVE' });
    const b = await makeDealer(ORG_LIMIT, 'Limit Two', { stage: 'ACTIVE' });
    const dA = await makeDraft(ORG_LIMIT, a.id, { kind: 'template', templateId: tpl.id, params: [] });
    const dB = await makeDraft(ORG_LIMIT, b.id, { kind: 'template', templateId: tpl.id, params: [] });
    assert.equal((await send(ORG_LIMIT, dA.id)).status, 'SENT');
    await assert.rejects(() => send(ORG_LIMIT, dB.id), /daily WhatsApp limit/);
  });

  test('a provider failure is recorded, keeps the draft retriable, and rethrows', async () => {
    const dealer = await makeDealer(ORG, 'Provider Down', { stage: 'ACTIVE' });
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    fake.failNextSend = 'WhatsApp API 400 (#131026): Message undeliverable';

    await assert.rejects(() => send(ORG, draft.id), /undeliverable/);

    const after = await raw.messageDraft.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(after.status, 'APPROVED');
    assert.match(after.lastSendError ?? '', /undeliverable/);
    const ev = await raw.interactionEvent.findFirst({ where: { dealerId: dealer.id, channel: 'WHATSAPP' } });
    assert.equal(ev?.status, 'FAILED');
    // …and a retry, with the provider healthy again, succeeds.
    assert.equal((await send(ORG, draft.id)).status, 'SENT');
  });
});

describe('warm-routing selector (§7)', () => {
  test('includes engaged, opted-in and relationship-stage dealers; excludes cold and opted-out', async () => {
    const cold = await makeDealer(ORG_OTHER, 'Sel Cold');
    const emailed = await makeDealer(ORG_OTHER, 'Sel Replied');
    await engage(ORG_OTHER, emailed.id);
    const optedIn = await makeDealer(ORG_OTHER, 'Sel Opted In');
    await consent(ORG_OTHER, optedIn.id, 'OPTED_IN');
    const active = await makeDealer(ORG_OTHER, 'Sel Active', { stage: 'ACTIVE' });
    const stopped = await makeDealer(ORG_OTHER, 'Sel Stopped', { stage: 'ACTIVE' });
    await consent(ORG_OTHER, stopped.id, 'OPTED_OUT');
    const noNumber = await raw.dealer.create({ data: { organizationId: ORG_OTHER, businessName: 'Sel No Phone', source: 'MANUAL', pipelineStage: 'ACTIVE' } });

    const ids = (await runWithOrg(ORG_OTHER, () => eligibleWarmDealers(db))).map((d) => d.id);

    for (const d of [emailed, optedIn, active]) assert.ok(ids.includes(d.id), d.businessName);
    for (const d of [cold, stopped, noNumber]) assert.ok(!ids.includes(d.id), d.businessName);
  });

  test('dealerIds can only narrow the set — naming a cold dealer does not admit them', async () => {
    const cold = await makeDealer(ORG_OTHER, 'Named But Cold');
    const ids = (await runWithOrg(ORG_OTHER, () => eligibleWarmDealers(db, { dealerIds: [cold.id] }))).map((d) => d.id);
    assert.deepEqual(ids, []);
  });

  test('a campaign drafts only to warm dealers and to the queue, never sends', async () => {
    const tpl = await makeTemplate(ORG_OTHER, { category: 'MARKETING' });
    const before = fake.templates.length;
    const res = await runWithOrg(ORG_OTHER, () => drafts.campaign({ templateId: tpl.id }));
    assert.ok(res.created >= 3);
    assert.equal(fake.templates.length, before, 'a campaign only drafts');
    const pending = await raw.messageDraft.findMany({ where: { organizationId: ORG_OTHER, sourceModule: 'outreach-whatsapp', status: 'PENDING' } });
    assert.ok(pending.length >= 3 && pending.every((d) => d.requiresApproval));
    // Running it again drafts nobody twice.
    const again = await runWithOrg(ORG_OTHER, () => drafts.campaign({ templateId: tpl.id }));
    assert.equal(again.created, 0);
  });

  test('an unapproved template cannot start a campaign', async () => {
    const tpl = await makeTemplate(ORG_OTHER, { status: 'PENDING' });
    await assert.rejects(() => runWithOrg(ORG_OTHER, () => drafts.campaign({ templateId: tpl.id })), /Meta must approve/);
  });
});

describe('inbound webhook (§5.3, §8)', () => {
  const payload = (messages: object[] = [], statuses: object[] = []) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-A', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PN }, contacts: [{ wa_id: '15555559001', profile: { name: 'New Inquirer' } }], messages, statuses } }] }],
  });
  const msg = (id: string, body: string, from = '15555559001') => ({ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });
  const deliver = (body: object, service = inbound) => {
    const { rawBody, headers } = fakeSignedWebhook(body);
    return service.handle(rawBody, headers);
  };
  const dealerByPhone = (e164: string) => raw.dealer.findFirst({ where: { organizationId: ORG, phones: { some: { e164 } } }, include: { consentLogs: { orderBy: { createdAt: 'desc' } } } });

  test('someone who messages the business number first becomes a warm INQUIRY dealer with a live window', async () => {
    await deliver(payload([msg('wamid.first', 'Hello, what is the price of your CCTV range?')]));

    const dealer = await dealerByPhone('+15555559001');
    assert.ok(dealer, 'a dealer is created');
    assert.equal(dealer!.source, 'INQUIRY');
    assert.equal(dealer!.businessName, 'New Inquirer');
    const whatsapp = dealer!.consentLogs.find((c) => c.channel === 'WHATSAPP')!;
    assert.equal(whatsapp.state, 'OPTED_IN');
    assert.equal(whatsapp.source, 'INBOUND_MESSAGE');
    // The other channels are NOT opted in by a WhatsApp message.
    assert.ok(dealer!.consentLogs.filter((c) => c.channel !== 'WHATSAPP').every((c) => c.state === 'UNKNOWN'));

    const convo = await raw.whatsAppConversation.findFirstOrThrow({ where: { dealerId: dealer!.id } });
    assert.ok(convo.sessionExpiresAt!.getTime() > Date.now() + 23 * 3_600_000, 'the 24h window is open');
    assert.equal(convo.state, 'PRICING');
    assert.equal(convo.needsHuman, true, 'pricing is a commitment — a person answers');

    // Pricing is a positive signal: NEW → CONTACTED → INTERESTED, each audited.
    assert.equal(dealer!.pipelineStage, 'INTERESTED');
    const audits = await raw.auditEvent.count({ where: { entityId: dealer!.id, action: 'PIPELINE_STAGE_CHANGED' } });
    assert.equal(audits, 2);
    assert.ok(sequenceCancelled.includes(dealer!.id), 'the email follow-up sequence is halted');

    const inboundEvents = await raw.interactionEvent.findMany({ where: { dealerId: dealer!.id, channel: 'WHATSAPP', direction: 'INBOUND' } });
    assert.equal(inboundEvents.length, 1);
    assert.equal(inboundEvents[0].body, 'Hello, what is the price of your CCTV range?');
  });

  test('a redelivered webhook changes nothing (idempotent on the message id)', async () => {
    const body = payload([msg('wamid.dup', 'hello there', '15555559002')]);
    await deliver(body);
    await deliver(body);
    const dealer = await dealerByPhone('+15555559002');
    const events = await raw.interactionEvent.count({ where: { dealerId: dealer!.id, direction: 'INBOUND' } });
    assert.equal(events, 1);
  });

  test('STOP is an opt-out, and the latest consent row wins', async () => {
    await deliver(payload([msg('wamid.hi', 'hi', '15555559003')]));
    const dealer = (await dealerByPhone('+15555559003'))!;
    await deliver(payload([msg('wamid.stop', 'STOP', '15555559003')]));

    const latest = await raw.consentLog.findFirstOrThrow({ where: { dealerId: dealer.id, channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' } });
    assert.equal(latest.state, 'OPTED_OUT');
    assert.equal(latest.source, 'EXPLICIT_UNSUBSCRIBE');
    // History is append-only: the earlier OPTED_IN row is still there.
    assert.equal(await raw.consentLog.count({ where: { dealerId: dealer.id, channel: 'WHATSAPP', state: 'OPTED_IN' } }), 1);
    // …and now a send is refused.
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    await assert.rejects(() => send(ORG, draft.id), /opted out/);
  });

  test('a bad signature is rejected before anything is written', async () => {
    const { rawBody } = fakeSignedWebhook(payload([msg('wamid.forged', 'hi', '15555559004')]));
    await assert.rejects(() => inbound.handle(rawBody, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }), /signature/);
    assert.equal(await dealerByPhone('+15555559004'), null);
    assert.equal(await raw.webhookEvent.count({ where: { providerEventId: 'msg:wamid.forged' } }), 0);
  });

  test('a failure mid-processing releases the idempotency row so Meta’s retry can succeed', async () => {
    let fail = true;
    const flaky = new WhatsAppInboundService(db, fake, new AuditService(db), {
      cancel: async () => {
        if (fail) throw new Error('transient failure');
      },
    } as never, new InboundBotRegistry());
    const body = payload([msg('wamid.retry', 'do you have a catalogue', '15555559005')]);

    await assert.rejects(() => deliver(body, flaky), /transient failure/);
    assert.equal(await raw.webhookEvent.count({ where: { providerEventId: 'msg:wamid.retry' } }), 0, 'not left marked as seen');

    fail = false;
    await deliver(body, flaky);
    const dealer = (await dealerByPhone('+15555559005'))!;
    assert.equal(await raw.interactionEvent.count({ where: { dealerId: dealer.id, direction: 'INBOUND' } }), 1, 'recorded exactly once');
    assert.equal((await raw.webhookEvent.findFirstOrThrow({ where: { providerEventId: 'msg:wamid.retry' } })).processedAt !== null, true);
  });

  test('delivery statuses are recorded against the original send; read maps to OPENED', async () => {
    const dealer = await makeDealer(ORG, 'Status Traders', { stage: 'ACTIVE' });
    const tpl = await makeTemplate(ORG);
    const draft = await makeDraft(ORG, dealer.id, { kind: 'template', templateId: tpl.id, params: [] });
    const sent = await send(ORG, draft.id);

    await deliver(payload([], [{ id: sent.providerMessageId, status: 'delivered', timestamp: '1788000001' }, { id: sent.providerMessageId, status: 'read', timestamp: '1788000002' }]));

    const events = await raw.interactionEvent.findMany({ where: { providerMessageId: sent.providerMessageId }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(events.map((e) => e.status), ['SENT', 'DELIVERED', 'OPENED']);
    assert.ok(events.every((e) => e.messageDraftId === draft.id));
  });

  test('a quality FLAGGED auto-pauses marketing; an upgrade does not, and a person resumes', async () => {
    const quality = (event: string) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA-A', changes: [{ field: 'phone_number_quality_update', value: { metadata: { phone_number_id: PN }, event, current_limit: 'TIER_1K' } }] }] });
    await deliver(quality('UPGRADE'));
    assert.equal((await raw.whatsAppAccount.findUniqueOrThrow({ where: { organizationId: ORG } })).broadcastsPausedByQuality, false);
    await deliver(quality('FLAGGED'));
    const acct = await raw.whatsAppAccount.findUniqueOrThrow({ where: { organizationId: ORG } });
    assert.equal(acct.broadcastsPausedByQuality, true);
    assert.equal(acct.qualityEvent, 'FLAGGED');
    await raw.whatsAppAccount.update({ where: { organizationId: ORG }, data: { broadcastsPausedByQuality: false } });
  });

  test('a template status update from Meta lands on the right template', async () => {
    const tpl = await makeTemplate(ORG, { status: 'PENDING', metaTemplateId: 'meta-tpl-1' });
    await deliver({ object: 'whatsapp_business_account', entry: [{ id: 'WABA-A', changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: 'meta-tpl-1', message_template_name: tpl.name, reason: 'INVALID_FORMAT' } }] }] });
    const after = await raw.whatsAppTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    assert.equal(after.status, 'REJECTED');
    assert.equal(after.rejectionReason, 'INVALID_FORMAT');
  });

  test('a webhook for a number no organization owns is ignored, not an error', async () => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA-X', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN-UNKNOWN' }, messages: [msg('wamid.stray', 'hi', '15555559006')] } }] }] };
    await deliver(body);
    assert.equal(await dealerByPhone('+15555559006'), null);
  });
});

describe('templates', () => {
  test('a valid template is created, submitted (with example values) and synced', async () => {
    const t = await runWithOrg(ORG, () => templates.create({ name: 'welcome_dealer', category: 'UTILITY', bodyText: 'Hi {{1}}, welcome to {{2}}. Reply anytime.', paramKeys: ['contactName', 'ourBusinessName'] }));
    assert.equal(t.status, 'DRAFT');
    const submitted = await runWithOrg(ORG, () => templates.submit(t.id));
    assert.equal(submitted.status, 'PENDING');
    assert.ok(submitted.metaTemplateId);
    assert.deepEqual(fake.submitted.at(-1)!.examples, ['Rajesh', 'WA Org A']);
    fake.templateStatus = { status: 'REJECTED', rejectionReason: 'TAG_CONTENT_MISMATCH' };
    const synced = await runWithOrg(ORG, () => templates.sync(t.id));
    assert.equal(synced.status, 'REJECTED');
    fake.templateStatus = { status: 'APPROVED' };
  });

  test('an invalid template is refused with the reason, before any call to Meta', async () => {
    const submittedBefore = fake.submitted.length;
    await assert.rejects(() => runWithOrg(ORG, () => templates.create({ name: 'Bad Name', category: 'UTILITY', bodyText: 'x' })), /lowercase/);
    assert.equal(fake.submitted.length, submittedBefore);
  });
});

describe('tenant scoping (§1.3)', () => {
  test('another org’s conversations, templates and account are invisible; unscoped queries fail', async () => {
    const other = await makeDealer(ORG_OTHER, 'Other Convo');
    await raw.whatsAppConversation.create({ data: { organizationId: ORG_OTHER, dealerId: other.id, phoneE164: other.phones[0].e164! } });

    assert.equal((await runWithOrg(ORG, () => db.whatsAppConversation.findMany({ where: { dealerId: other.id } }))).length, 0);
    assert.equal(await runWithOrg(ORG, () => db.whatsAppAccount.findFirst({ where: { organizationId: ORG_OTHER } })).catch(() => 'refused'), 'refused');

    for (const q of [() => db.whatsAppConversation.findMany(), () => db.whatsAppTemplate.findMany(), () => db.whatsAppAccount.findMany()]) {
      await assert.rejects(q, /no org context/);
    }
  });
});
