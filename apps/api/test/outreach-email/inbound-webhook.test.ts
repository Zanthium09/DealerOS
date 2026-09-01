// §6 / §8 / §13 — the inbound-receiving webhook: signature verification over the
// genuine raw bytes, idempotency on WebhookEvent(provider, providerEventId), and that
// a verified delivery actually reaches InboundEmailService with the right shape.
// InboundEmailService's own threading/classification/consent behaviour is already
// fully covered by inbound.test.ts — this file is only about the glue in front of it.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { FakeAIProvider } from '../../src/providers/ai/fake.provider';
import { InboundEmailService } from '../../src/modules/outreach-email/inbound.service';
import { buildMessageId } from '../../src/modules/outreach-email/message-id';
import { SequenceService } from '../../src/modules/outreach-email/sequence.service';
import { ResendInboundWebhookService } from '../../src/modules/outreach-email/inbound-webhook.service';
import { FakeEmailProvider, fakeInboundWebhookRequest } from '../../src/providers/email';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());
const audit = new AuditService(scoped as unknown as PrismaClient);

class NoopSequence {
  async cancel() {}
}

const ORG = 'inbound-webhook-org';
const DOMAIN = 'mail-inbound-webhook.in';

async function mkDealerWithSend(dealerId: string): Promise<string> {
  await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: `Webhook ${dealerId}`, source: 'MANUAL', pipelineStage: 'NEW' } });
  const event = await raw.interactionEvent.create({
    data: { organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', body: 'our cold email' },
  });
  return event.id;
}

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Inbound Webhook Co', slug: ORG } });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

function service() {
  const email = new FakeEmailProvider();
  const inbound = new InboundEmailService(
    scoped as unknown as PrismaClient,
    new FakeAIProvider('HUMAN_REPLY'),
    audit,
    new NoopSequence() as unknown as SequenceService,
  );
  const svc = new ResendInboundWebhookService(scoped as unknown as PrismaClient, email, inbound);
  return { svc, email };
}

describe('§8 — signature verification', () => {
  test('a bad signature is refused, not silently accepted', async () => {
    const { svc } = service();
    const { rawBody } = fakeInboundWebhookRequest('email-1');
    await assert.rejects(svc.handle(rawBody, { 'svix-signature': 'wrong' }), /signature/i);
  });
});

describe('§8 — idempotency', () => {
  test('the same email.received delivery is processed exactly once', async () => {
    const { svc, email } = service();
    const dealerId = 'webhook-dealer-idem';
    const initialId = await mkDealerWithSend(dealerId);
    email.receivedEmails.set('email-idem', {
      headers: { 'In-Reply-To': buildMessageId(ORG, initialId, DOMAIN) },
      subject: 'Re: our cold email',
      text: 'Yes, tell me more please.',
      html: null,
      fromAddress: 'owner@dealer.example',
    });
    const { rawBody, headers } = fakeInboundWebhookRequest('email-idem');

    const first = await svc.handle(rawBody, headers);
    const second = await svc.handle(rawBody, headers); // Resend's retry

    assert.equal(first.deduped, undefined);
    assert.equal(second.deduped, true);

    const replies = await raw.interactionEvent.findMany({ where: { organizationId: ORG, dealerId, direction: 'INBOUND' } });
    assert.equal(replies.length, 1, 'the retry must not double-log the reply');

    const rows = await raw.webhookEvent.findMany({ where: { provider: 'resend-inbound', providerEventId: 'email.received:email-idem' } });
    assert.equal(rows.length, 1);
  });
});

describe('end to end — a verified delivery reaches InboundEmailService', () => {
  test('html-only content falls back to htmlToPlainText, and the reply moves the dealer to CONTACTED', async () => {
    const { svc, email } = service();
    const dealerId = 'webhook-dealer-html';
    const initialId = await mkDealerWithSend(dealerId);
    email.receivedEmails.set('email-html', {
      headers: { 'In-Reply-To': buildMessageId(ORG, initialId, DOMAIN) },
      subject: 'Re: our cold email',
      text: null,
      html: '<p>Yes, please tell me more about pricing.</p>',
      fromAddress: 'owner@dealer.example',
    });
    const { rawBody, headers } = fakeInboundWebhookRequest('email-html');

    await svc.handle(rawBody, headers);

    const dealer = await raw.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    assert.equal(dealer.pipelineStage, 'CONTACTED');

    const reply = await raw.interactionEvent.findFirst({ where: { organizationId: ORG, dealerId, direction: 'INBOUND' } });
    assert.match(reply!.body, /Yes, please tell me more about pricing\./);
    assert.doesNotMatch(reply!.body, /<p>/);
  });

  test('an event type this app does not process is a no-op, not an error', async () => {
    const { svc } = service();
    const rawBody = Buffer.from(JSON.stringify({ type: 'email.bounced', data: { email_id: 'irrelevant' } }));
    const result = await svc.handle(rawBody, { 'svix-signature': 'v1,test-inbound-signature' });
    assert.deepEqual(result, {});
  });
});
