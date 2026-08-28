// §12.6 / §13 — the kill switch: pause without a deploy, survive a restart, gate
// outbound sends only. Real Redis (the actual persistence this relies on).
import '../support';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenancyModule } from '../../src/core/tenancy/tenancy.module';
import { WebhooksModule, ADAPTERS } from '../../src/core/webhooks/webhooks.module';
import { hmacSha256Adapter, type WebhookAdapter } from '../../src/core/webhooks/webhook-adapter';
import { KillSwitchService, ChannelPausedError } from '../../src/core/killswitch/killswitch.service';
import { assertSendAllowed, StagingSendBlockedError } from '../../src/core/killswitch/staging-guard';
import { newRedisConnection } from '../../src/core/redis';

const raw = new PrismaClient();

describe('§12.6 — kill switch', () => {
  const redisA = newRedisConnection();
  const redisB = newRedisConnection(); // stands in for "a different process"

  after(() => {
    redisA.disconnect();
    redisB.disconnect();
  });

  test('a fresh channel is not paused', async () => {
    const svc = new KillSwitchService(redisA);
    assert.equal(await svc.isPaused('WHATSAPP'), false);
  });

  test('pause blocks sends; resume unblocks them', async () => {
    const svc = new KillSwitchService(redisA);
    await svc.pause('EMAIL');
    assert.equal(await svc.isPaused('EMAIL'), true);
    await assert.rejects(() => svc.assertNotPaused('EMAIL'), ChannelPausedError);

    await svc.resume('EMAIL');
    assert.equal(await svc.isPaused('EMAIL'), false);
    await svc.assertNotPaused('EMAIL'); // does not throw
  });

  test('state survives a process restart — a fresh connection sees the same pause', async () => {
    const beforeRestart = new KillSwitchService(redisA);
    await beforeRestart.pause('CALL');

    // A brand new connection, standing in for a brand new process: nothing about the
    // pause lives in this process's memory, so this is the actual proof it persisted.
    const afterRestart = new KillSwitchService(redisB);
    assert.equal(await afterRestart.isPaused('CALL'), true);

    await afterRestart.resume('CALL'); // cleanup
  });
});

describe('§7 — a paused channel still lets inbound processing run', () => {
  const ORG = 'ks-org';
  const DEALER = 'ks-dealer';
  const SECRET = 'ks-test-secret-0123456789';
  const HEADER = 'x-signature';
  const PREFIX = 'sha256=';

  const adapters = new Map<string, WebhookAdapter>();
  adapters.set(
    'acme',
    hmacSha256Adapter({
      secret: SECRET,
      signatureHeader: HEADER,
      signaturePrefix: PREFIX,
      eventIdPath: 'id',
      toInteractionEvent: (payload) => {
        const p = payload as { id: string };
        return {
          organizationId: ORG,
          dealerId: DEALER,
          // A channel distinct from the first describe block's WHATSAPP checks — the
          // two run concurrently against the same real Redis (§12.6), and sharing a
          // channel name races: this block pausing WHATSAPP for its own life can be
          // observed by the other block's "a fresh channel is not paused" assertion.
          channel: 'EMAIL',
          direction: 'INBOUND',
          status: 'DELIVERED',
          body: 'inbound while paused',
          providerMessageId: p.id,
        };
      },
    }),
  );

  let app: INestApplication;
  let base: string;
  let pauseRedis: ReturnType<typeof newRedisConnection>;

  before(async () => {
    await raw.organization.create({ data: { id: ORG, name: 'KillSwitch Co', slug: ORG } });
    await raw.dealer.create({
      data: { id: DEALER, organizationId: ORG, businessName: 'KillSwitch Traders', source: 'MANUAL' },
    });

    // See webhooks.test.ts — a distinct queue name per test file's WebhooksModule
    // instance, so its Worker never picks up (and mis-attributes) another file's job.
    process.env.WEBHOOK_QUEUE_NAME = `webhook-processing-test-killswitch-${Date.now()}`;

    const moduleRef = await Test.createTestingModule({ imports: [TenancyModule, WebhooksModule] })
      .overrideProvider(ADAPTERS)
      .useValue(adapters)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;

    // The channel is paused for the whole life of this describe block — outbound
    // broadcasts on that channel would refuse; inbound ingestion below never checks this
    // at all, which is the point.
    pauseRedis = newRedisConnection();
    const svc = new KillSwitchService(pauseRedis);
    await svc.pause('EMAIL');
  });

  after(async () => {
    await new KillSwitchService(pauseRedis).resume('EMAIL'); // leave shared Redis clean
    await app.close();
    await raw.$disconnect();
    pauseRedis.disconnect();
  });

  test('an inbound webhook on a paused channel is still ingested and logged', async () => {
    const body = '{"id":"evt-inbound-while-paused"}';
    const signature = PREFIX + createHmac('sha256', SECRET).update(body).digest('hex');

    const res = await fetch(`${base}/webhooks/acme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER]: signature },
      body,
    });
    assert.equal(res.status, 200);

    const start = Date.now();
    let interaction = null;
    while (Date.now() - start < 5000 && !interaction) {
      interaction = await raw.interactionEvent.findFirst({
        where: { organizationId: ORG, providerMessageId: 'evt-inbound-while-paused' },
      });
      if (!interaction) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(interaction, 'inbound InteractionEvent should be written even while the channel is paused');
  });
});

describe('§12.7 — staging guard', () => {
  test('blocks a real-looking phone or email outside production', () => {
    assert.throws(() => assertSendAllowed({ phoneE164: '+919876543210' }), StagingSendBlockedError);
    assert.throws(() => assertSendAllowed({ email: 'owner@realdealer.co.in' }), StagingSendBlockedError);
  });

  test('allows recognised test destinations outside production', () => {
    assertSendAllowed({ phoneE164: '+15551234567' });
    assertSendAllowed({ email: 'someone@example.com' });
  });

  test('does not restrict sends when NODE_ENV=production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assertSendAllowed({ phoneE164: '+919876543210', email: 'owner@realdealer.co.in' });
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
