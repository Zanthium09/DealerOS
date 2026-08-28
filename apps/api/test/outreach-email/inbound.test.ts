// §6 / §5.2 / §13 — inbound reply handling: threading, classification, and the one
// rule that matters most — only a HUMAN_REPLY may move a dealer to INTERESTED-bound
// CONTACTED. An out-of-office must never do that.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { FakeAIProvider } from '../../src/providers/ai/fake.provider';
import { InboundEmailError, InboundEmailService } from '../../src/modules/outreach-email/inbound.service';
import { buildMessageId } from '../../src/modules/outreach-email/message-id';
import { SequenceService } from '../../src/modules/outreach-email/sequence.service';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());
const audit = new AuditService(scoped as unknown as PrismaClient);

class RecordingSequence {
  cancelled: { organizationId: string; dealerId: string }[] = [];
  async cancel(organizationId: string, dealerId: string) {
    this.cancelled.push({ organizationId, dealerId });
  }
}

const ORG = 'inbound-org';
const DOMAIN = 'mail-inbound.in';

async function mkDealerWithSend(dealerId: string): Promise<string> {
  await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: `Inbound ${dealerId}`, source: 'MANUAL', pipelineStage: 'NEW' } });
  const event = await raw.interactionEvent.create({
    data: { organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', body: 'our cold email' },
  });
  return event.id;
}

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Inbound Co', slug: ORG } });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

function service(aiReply?: string) {
  const sequence = new RecordingSequence();
  const svc = new InboundEmailService(
    scoped as unknown as PrismaClient,
    new FakeAIProvider(aiReply),
    audit,
    sequence as unknown as SequenceService,
  );
  return { svc, sequence };
}

describe('threading', () => {
  test('a reply with no References/In-Reply-To we recognise is refused', async () => {
    const { svc } = service();
    await assert.rejects(
      svc.handle({ headers: {}, subject: 'Re: hi', body: 'hi', fromAddress: 'x@example.com' }),
      InboundEmailError,
    );
  });

  test('References is used when In-Reply-To is absent (reverse-scanned per RFC 5322)', async () => {
    const dealerId = 'inbound-dealer-refs';
    const initialId = await mkDealerWithSend(dealerId);
    const { svc } = service('HUMAN_REPLY');
    await svc.handle({
      headers: { References: `<unrelated@x> ${buildMessageId(ORG, initialId, DOMAIN)}` },
      subject: 'Re: our cold email',
      body: 'Tell me more please',
      fromAddress: 'owner@dealer.example',
    });
    const dealer = await raw.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    assert.equal(dealer.pipelineStage, 'CONTACTED');
  });
});

describe('only HUMAN_REPLY moves the dealer to CONTACTED (§5.2, §10.5-style caution)', () => {
  test('a genuine human reply transitions NEW -> CONTACTED and writes an AuditEvent', async () => {
    const dealerId = 'inbound-dealer-human';
    const initialId = await mkDealerWithSend(dealerId);
    const { svc, sequence } = service('HUMAN_REPLY');

    await svc.handle({
      headers: { 'In-Reply-To': buildMessageId(ORG, initialId, DOMAIN) },
      subject: 'Re: our cold email',
      body: 'Yes, please tell me more about pricing and availability.',
      fromAddress: 'owner@dealer.example',
    });

    const dealer = await raw.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    assert.equal(dealer.pipelineStage, 'CONTACTED');

    const events = await raw.auditEvent.findMany({ where: { organizationId: ORG, entityType: 'Dealer', entityId: dealerId } });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'PIPELINE_STAGE_CHANGED');
    assert.deepEqual(events[0].metadata, { from: 'NEW', to: 'CONTACTED', reason: 'HUMAN_REPLY to cold outreach email (§5.2)' });

    assert.deepEqual(sequence.cancelled, [{ organizationId: ORG, dealerId }]);
  });

  test('an out-of-office does NOT move the dealer to CONTACTED — the failure to avoid', async () => {
    const dealerId = 'inbound-dealer-ooo';
    const initialId = await mkDealerWithSend(dealerId);
    const { svc, sequence } = service();

    await svc.handle({
      headers: { 'In-Reply-To': buildMessageId(ORG, initialId, DOMAIN), 'Auto-Submitted': 'auto-replied' },
      subject: 'Out of Office: Re: our cold email',
      body: "I'm out of office until next week.",
      fromAddress: 'owner@dealer.example',
    });

    const dealer = await raw.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    assert.equal(dealer.pipelineStage, 'NEW', 'must stay NEW — an autoresponder is not interest');

    const events = await raw.auditEvent.findMany({ where: { organizationId: ORG, entityType: 'Dealer', entityId: dealerId } });
    assert.equal(events.length, 0, 'no pipeline transition means no PIPELINE_STAGE_CHANGED event');

    // Still halts the sequence — a reply of any kind stops the follow-ups.
    assert.deepEqual(sequence.cancelled, [{ organizationId: ORG, dealerId }]);
  });

  test('a bounce-classified inbound also leaves the dealer at NEW', async () => {
    const dealerId = 'inbound-dealer-bounce';
    const initialId = await mkDealerWithSend(dealerId);
    const { svc } = service();
    await svc.handle({
      headers: { 'In-Reply-To': buildMessageId(ORG, initialId, DOMAIN) },
      subject: 'Undelivered Mail Returned to Sender',
      body: '',
      fromAddress: 'mailer-daemon@dealer.example',
    });
    const dealer = await raw.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    assert.equal(dealer.pipelineStage, 'NEW');
  });
});

describe('an inbound unsubscribe request opts the dealer out and suppresses them', () => {
  test('ConsentLog OPTED_OUT and a Suppression row, no pipeline transition', async () => {
    const dealerId = 'inbound-dealer-unsub';
    const initialId = await mkDealerWithSend(dealerId);
    const { svc } = service();

    await svc.handle({
      headers: { 'In-Reply-To': buildMessageId(ORG, initialId, DOMAIN) },
      subject: 'Re: our cold email',
      body: 'Please unsubscribe me, not interested.',
      fromAddress: 'owner@dealer.example',
    });

    const consent = await raw.consentLog.findFirst({ where: { organizationId: ORG, dealerId, channel: 'EMAIL' }, orderBy: { createdAt: 'desc' } });
    assert.equal(consent?.state, 'OPTED_OUT');
    assert.equal(consent?.source, 'EXPLICIT_UNSUBSCRIBE');

    const suppression = await raw.suppression.findFirst({ where: { organizationId: ORG, email: 'owner@dealer.example' } });
    assert.ok(suppression);

    const dealer = await raw.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    assert.equal(dealer.pipelineStage, 'NEW');
  });
});

describe('§1.3 — the org is read from the Message-ID, never guessed or defaulted', () => {
  test('an org id embedded in the Message-ID that does not exist throws rather than leaking into another org', async () => {
    const { svc } = service('HUMAN_REPLY');
    await assert.rejects(
      runWithOrg(ORG, () =>
        svc.handle({
          headers: { 'In-Reply-To': buildMessageId('some-other-org-nobody-created', 'whatever', DOMAIN) },
          subject: 'Re: hi',
          body: 'hi',
          fromAddress: 'x@example.com',
        }),
      ),
      /tenancy|no InteractionEvent/i,
    );
  });
});
