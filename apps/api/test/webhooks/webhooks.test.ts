// §8 / §13 — webhook idempotency and signature verification, real Postgres and a real
// HTTP round trip (raw bytes matter here, so no shortcuts through the `req()` helper,
// which JSON.stringifies its body and would hide exactly the bug this file guards
// against).
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

const raw = new PrismaClient();

const ORG = 'wh-org';
const DEALER = 'wh-dealer';
const SECRET = 'wh-test-secret-0123456789';
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
      const p = payload as { id: string; text?: string };
      return {
        organizationId: ORG,
        dealerId: DEALER,
        channel: 'EMAIL',
        direction: 'INBOUND',
        status: 'DELIVERED',
        body: p.text ?? '',
        providerMessageId: p.id,
      };
    },
  }),
);

function sign(bodyBytes: string): string {
  return PREFIX + createHmac('sha256', SECRET).update(bodyBytes).digest('hex');
}

let app: INestApplication;
let base: string;

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Webhook Co', slug: ORG } });
  await raw.dealer.create({
    data: { id: DEALER, organizationId: ORG, businessName: 'Webhook Traders', source: 'MANUAL' },
  });

  // A test-file-unique queue name — webhooks.module.ts reads this at provider-factory
  // time. Without it, this suite's Worker and any other test file's Worker booted
  // against the same real Redis would both poll the literal "webhook-processing"
  // queue and steal each other's jobs (see webhook-queue.ts).
  process.env.WEBHOOK_QUEUE_NAME = `webhook-processing-test-webhooks-${Date.now()}`;

  const moduleRef = await Test.createTestingModule({ imports: [TenancyModule, WebhooksModule] })
    .overrideProvider(ADAPTERS)
    .useValue(adapters)
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  await raw.$disconnect();
});

async function post(bodyBytes: string, headers: Record<string, string>) {
  return fetch(`${base}/webhooks/acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: bodyBytes,
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

describe('§8 — webhook signature verification runs on the raw body', () => {
  test('valid signature over the exact bytes sent is accepted', async () => {
    const body = '{"id":"evt-sig-ok","text":"hello"}';
    const res = await post(body, { [HEADER]: sign(body) });
    assert.equal(res.status, 200);
  });

  test('unsigned payload is rejected', async () => {
    const body = '{"id":"evt-unsigned","text":"hi"}';
    const res = await post(body, {});
    assert.equal(res.status, 401);
  });

  test('wrongly-signed payload is rejected', async () => {
    const body = '{"id":"evt-wrong-sig","text":"hi"}';
    const res = await post(body, { [HEADER]: PREFIX + 'a'.repeat(64) });
    assert.equal(res.status, 401);
  });

  test('truncated signature is rejected, not crashed on', async () => {
    const body = '{"id":"evt-truncated","text":"hi"}';
    const full = sign(body);
    const res = await post(body, { [HEADER]: full.slice(0, full.length - 4) });
    assert.equal(res.status, 401);
  });

  test('a signature computed over a re-serialised body fails — proves raw bytes are what is checked', async () => {
    // Deliberately non-canonical formatting: JSON.stringify(JSON.parse(raw)) produces
    // different bytes (no spaces, different key order) than what is actually sent.
    const wireBody = '{"text": "hi",   "id":"evt-reserialised"}';
    const reserialised = JSON.stringify(JSON.parse(wireBody));
    assert.notEqual(wireBody, reserialised, 'fixture must actually differ once reserialised');

    const res = await post(wireBody, { [HEADER]: sign(reserialised) });
    assert.equal(res.status, 401);
  });
});

describe('§8 / §13 — webhook idempotency', () => {
  test('the same providerEventId twice produces one WebhookEvent and one InteractionEvent', async () => {
    const body = '{"id":"evt-dup-sequential","text":"once please"}';
    const headers = { [HEADER]: sign(body) };

    const first = await post(body, headers);
    const second = await post(body, headers);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { deduped: boolean };
    assert.equal(secondBody.deduped, true);

    await waitFor(() =>
      raw.webhookEvent.findFirst({ where: { provider: 'acme', providerEventId: 'evt-dup-sequential' }, }).then((e) => e?.processedAt ?? null),
    );

    const events = await raw.webhookEvent.findMany({
      where: { provider: 'acme', providerEventId: 'evt-dup-sequential' },
    });
    assert.equal(events.length, 1);

    const interactions = await raw.interactionEvent.findMany({
      where: { organizationId: ORG, providerMessageId: 'evt-dup-sequential' },
    });
    assert.equal(interactions.length, 1);
  });

  test('two concurrent deliveries of the same event still produce exactly one of each row', async () => {
    const body = '{"id":"evt-dup-concurrent","text":"race me"}';
    const headers = { [HEADER]: sign(body) };

    const [a, b] = await Promise.all([post(body, headers), post(body, headers)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    await waitFor(() =>
      raw.webhookEvent
        .findFirst({ where: { provider: 'acme', providerEventId: 'evt-dup-concurrent' } })
        .then((e) => e?.processedAt ?? null),
    );

    const events = await raw.webhookEvent.findMany({
      where: { provider: 'acme', providerEventId: 'evt-dup-concurrent' },
    });
    assert.equal(events.length, 1);

    const interactions = await raw.interactionEvent.findMany({
      where: { organizationId: ORG, providerMessageId: 'evt-dup-concurrent' },
    });
    assert.equal(interactions.length, 1);
  });
});
