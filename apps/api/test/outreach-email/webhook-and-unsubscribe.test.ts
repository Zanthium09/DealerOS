// §8 / §6 / §13 — webhook idempotency, a BOUNCED event writing ConsentLog OPTED_OUT,
// and the unsubscribe endpoint actually opting a dealer out. Real Postgres, no mocks;
// the "provider" is FakeEmailProvider so no network is ever touched.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { withTenancy } from '../../src/core/tenancy/tenancy';
import { SequenceService } from '../../src/modules/outreach-email/sequence.service';
import { OutreachEmailWebhookService } from '../../src/modules/outreach-email/webhook.service';
import { UnsubscribeEndpointService } from '../../src/modules/outreach-email/unsubscribe-endpoint.service';
import { unsubscribeToken } from '../../src/modules/outreach-email/unsubscribe';
import { FakeEmailProvider, fakeWebhookEvent } from '../../src/providers/email';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());
const CONFIG = { unsubscribeSecret: 'webhook-test-secret', publicBaseUrl: 'https://app.test' };

// A stand-in for SequenceService that only records whether cancel() was called —
// this file is about webhook/unsubscribe behaviour, sequence.test.ts already proves
// cancellation is real; here it is enough to prove webhook.service.ts CALLS it.
class RecordingSequence {
  cancelled: { organizationId: string; dealerId: string }[] = [];
  async cancel(organizationId: string, dealerId: string) {
    this.cancelled.push({ organizationId, dealerId });
  }
}

const ORG = 'webhook-org';
const DEALER = 'webhook-dealer';

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Webhook Co', slug: ORG } });
  await raw.dealer.create({ data: { id: DEALER, organizationId: ORG, businessName: 'Webhook Traders', source: 'MANUAL' } });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('§8 — webhook idempotency', () => {
  test('the same providerEventId is processed exactly once', async () => {
    const email = new FakeEmailProvider();
    const sequence = new RecordingSequence();
    const svc = new OutreachEmailWebhookService(scoped as unknown as PrismaClient, email, sequence as unknown as SequenceService);

    const interactionEventId = 'webhook-interaction-1';
    await raw.interactionEvent.create({
      data: { id: interactionEventId, organizationId: ORG, dealerId: DEALER, channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', body: 'hi', providerMessageId: 'fake-msg-1' },
    });
    const payload = fakeWebhookEvent('fake-msg-1', 'DELIVERED', { organizationId: ORG, dealerId: DEALER, interactionEventId }, 'evt-fixed-id');

    await svc.handle(payload, 'test-signature');
    await svc.handle(payload, 'test-signature'); // the provider's retry

    const rows = await raw.interactionEvent.findMany({ where: { organizationId: ORG, dealerId: DEALER, status: 'DELIVERED' } });
    assert.equal(rows.length, 1, 'the retry must not double-log the delivery');
    const webhookRows = await raw.webhookEvent.findMany({ where: { providerEventId: 'evt-fixed-id' } });
    assert.equal(webhookRows.length, 1);
  });

  test('a signature that does not verify is refused, not silently accepted', async () => {
    const email = new FakeEmailProvider();
    const sequence = new RecordingSequence();
    const svc = new OutreachEmailWebhookService(scoped as unknown as PrismaClient, email, sequence as unknown as SequenceService);
    const payload = fakeWebhookEvent('fake-msg-x', 'DELIVERED', { organizationId: ORG, dealerId: DEALER, interactionEventId: 'x' });
    await assert.rejects(svc.handle(payload, 'wrong-signature'), /signature/i);
  });
});

describe('§6 — a BOUNCED event writes ConsentLog OPTED_OUT with source BOUNCE, and halts the sequence', () => {
  test('bounce handling end to end', async () => {
    const email = new FakeEmailProvider();
    const sequence = new RecordingSequence();
    const svc = new OutreachEmailWebhookService(scoped as unknown as PrismaClient, email, sequence as unknown as SequenceService);

    const dealerId = 'webhook-dealer-bounce';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: 'Bounce Co', source: 'MANUAL' } });
    const interactionEventId = 'webhook-interaction-bounce';
    await raw.interactionEvent.create({
      data: { id: interactionEventId, organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', body: 'hi', providerMessageId: 'fake-msg-bounce' },
    });

    const payload = fakeWebhookEvent('fake-msg-bounce', 'BOUNCED', { organizationId: ORG, dealerId, interactionEventId });
    await svc.handle(payload, 'test-signature');

    const consent = await raw.consentLog.findFirst({ where: { organizationId: ORG, dealerId, channel: 'EMAIL' }, orderBy: { createdAt: 'desc' } });
    assert.equal(consent?.state, 'OPTED_OUT');
    assert.equal(consent?.source, 'BOUNCE');

    const bounceEvent = await raw.interactionEvent.findFirst({ where: { organizationId: ORG, dealerId, status: 'BOUNCED' } });
    assert.ok(bounceEvent);

    assert.deepEqual(sequence.cancelled, [{ organizationId: ORG, dealerId }]);
  });

  test('a CLICKED event also halts the sequence (no consent change)', async () => {
    const email = new FakeEmailProvider();
    const sequence = new RecordingSequence();
    const svc = new OutreachEmailWebhookService(scoped as unknown as PrismaClient, email, sequence as unknown as SequenceService);

    const dealerId = 'webhook-dealer-click';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: 'Click Co', source: 'MANUAL' } });
    const interactionEventId = 'webhook-interaction-click';
    await raw.interactionEvent.create({
      data: { id: interactionEventId, organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', body: 'hi', providerMessageId: 'fake-msg-click' },
    });
    const payload = fakeWebhookEvent('fake-msg-click', 'CLICKED', { organizationId: ORG, dealerId, interactionEventId });
    await svc.handle(payload, 'test-signature');

    assert.deepEqual(sequence.cancelled, [{ organizationId: ORG, dealerId }]);
  });
});

describe('§6 — the unsubscribe endpoint actually opts the dealer out', () => {
  test('a valid token writes ConsentLog OPTED_OUT and a Suppression row', async () => {
    const dealerId = 'unsub-dealer-1';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: 'Unsub Co', source: 'MANUAL' } });
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'unsub@example.com', isPrimary: true, verificationStatus: 'VALID' } });

    const svc = new UnsubscribeEndpointService(scoped as unknown as PrismaClient, CONFIG);
    const token = unsubscribeToken(CONFIG.unsubscribeSecret, ORG, dealerId);
    await svc.unsubscribe(token);

    const consent = await raw.consentLog.findFirst({ where: { organizationId: ORG, dealerId, channel: 'EMAIL' }, orderBy: { createdAt: 'desc' } });
    assert.equal(consent?.state, 'OPTED_OUT');
    assert.equal(consent?.source, 'EXPLICIT_UNSUBSCRIBE');

    const suppression = await raw.suppression.findFirst({ where: { organizationId: ORG, email: 'unsub@example.com' } });
    assert.ok(suppression);
  });

  test('a tampered token is refused', async () => {
    const svc = new UnsubscribeEndpointService(scoped as unknown as PrismaClient, CONFIG);
    const token = unsubscribeToken(CONFIG.unsubscribeSecret, ORG, 'unsub-dealer-1');
    await assert.rejects(svc.unsubscribe(token + 'x'), /invalid|tampered/i);
  });

  test('a token signed with a different secret is refused', async () => {
    const svc = new UnsubscribeEndpointService(scoped as unknown as PrismaClient, CONFIG);
    const token = unsubscribeToken('a-different-secret', ORG, 'unsub-dealer-1');
    await assert.rejects(svc.unsubscribe(token), /invalid|tampered/i);
  });
});
