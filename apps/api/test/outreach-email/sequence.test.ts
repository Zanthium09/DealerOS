// §6 / §13 — "sequences halt on reply, click, bounce, opt-out — with the delayed jobs
// actually cancelled." Real Postgres AND real Redis/BullMQ (docker-compose, :6380) —
// no mocks, because the whole point under test is whether cancellation is real.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit';
import { ApprovalService } from '../../src/core/approval';
import { DraftingService } from '../../src/core/drafting';
import { FakeAIProvider } from '../../src/providers/ai/fake.provider';
import { FakeEmailProvider } from '../../src/providers/email';
import { ColdDraftService } from '../../src/modules/outreach-email/cold-draft.service';
import { EmailSendService } from '../../src/modules/outreach-email/send.service';
import { AlwaysAllowThrottle, NeverPausedKillSwitch } from '../../src/modules/outreach-email/ports';
import { SequenceService, SEQUENCE_QUEUE_NAME } from '../../src/modules/outreach-email/sequence.service';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());
const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6380', maxRetriesPerRequest: null };

const audit = new AuditService(scoped as unknown as PrismaClient);
const RULES = [{ id: 'cold-email-no-money', sourceModule: 'outreach-email' }];
const approval = new ApprovalService(scoped as unknown as PrismaClient, audit, RULES);
const ai = new FakeAIProvider();
const drafting = new DraftingService(scoped as unknown as PrismaClient, ai, RULES);
const coldDraft = new ColdDraftService(drafting);
const CONFIG = { unsubscribeSecret: 'test-secret', publicBaseUrl: 'https://app.test' };

const STEP_DELAY_MS = 300;
const WAIT_MS = 2500;
// Long enough that the happy-path test can observe "step 1 fired" without also
// catching step 2 — step 1 uses STEP_DELAY_MS, step 2 uses this, deliberately far apart.
const STEP2_DELAY_MS = 8000;

function newSequenceService(steps: readonly [number, number] = [STEP_DELAY_MS, STEP_DELAY_MS]) {
  const email = new FakeEmailProvider();
  const send = new EmailSendService(
    scoped as unknown as PrismaClient,
    email,
    new AlwaysAllowThrottle(),
    new NeverPausedKillSwitch(),
    CONFIG,
  );
  const seq = new SequenceService(scoped as unknown as PrismaClient, coldDraft, approval, send, steps, connection);
  return { email, seq };
}

const inspectQueue = new Queue(SEQUENCE_QUEUE_NAME, { connection });

const ORG = 'seq-org';

async function mkDealer(id: string): Promise<void> {
  await raw.dealer.create({ data: { id, organizationId: ORG, businessName: `Seq ${id}`, source: 'MANUAL', pipelineStage: 'NEW' } });
}

async function initialSend(dealerId: string): Promise<string> {
  // Emulate an already-sent initial cold email — the state SequenceService.start()
  // is invoked after, in the real flow (outreach-email.service.ts).
  const draft = await raw.messageDraft.create({
    data: { organizationId: ORG, dealerId, sourceModule: 'outreach-email', draftText: 'hi', status: 'AUTO_SENT', autoSendRuleId: 'cold-email-no-money' },
  });
  const event = await raw.interactionEvent.create({
    data: { organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', messageDraftId: draft.id, status: 'SENT', body: 'hi' },
  });
  return event.id;
}

const followUpCount = (dealerId: string) => raw.messageDraft.count({ where: { organizationId: ORG, dealerId, sourceModule: 'outreach-email' } });

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Sequence Co', slug: ORG } });
  await raw.sendingIdentity.create({ data: { organizationId: ORG, domain: 'mail-seq.in', provider: 'resend', verificationStatus: 'VERIFIED', currentDailyLimit: 100 } });
});

after(async () => {
  await inspectQueue.obliterate({ force: true }).catch(() => {});
  await inspectQueue.close();
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('the happy path — nothing halts it', () => {
  test('follow-up 1 fires after the delay, and schedules follow-up 2', async () => {
    const dealerId = 'seq-happy';
    await mkDealer(dealerId);
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'happy@example.com', isPrimary: true, verificationStatus: 'VALID' } });
    const initialId = await initialSend(dealerId);

    const { seq } = newSequenceService([STEP_DELAY_MS, STEP2_DELAY_MS]);
    try {
      await runWithOrg(ORG, () => seq.start(ORG, dealerId, initialId));
      assert.equal(await followUpCount(dealerId), 1, 'only the initial draft exists before the delay elapses');

      await new Promise((r) => setTimeout(r, WAIT_MS));

      // Step 2 is scheduled STEP2_DELAY_MS after step 1 fires, so this window catches
      // step 1 having fired without also catching step 2.
      assert.equal(await followUpCount(dealerId), 2, 'follow-up 1 drafted (and sent) after the delay');
      const step2 = await inspectQueue.getJob(`seq.${ORG}.${dealerId}.2`);
      assert.ok(step2, 'follow-up 1 firing schedules follow-up 2');
    } finally {
      await seq.onModuleDestroy();
    }
  });
});

describe('cancel() removes the delayed job — the fast path', () => {
  test('a cancelled sequence never fires follow-up 1, and the job is gone from the queue', async () => {
    const dealerId = 'seq-cancelled';
    await mkDealer(dealerId);
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'cancelled@example.com', isPrimary: true, verificationStatus: 'VALID' } });
    const initialId = await initialSend(dealerId);

    const { seq } = newSequenceService();
    try {
      await runWithOrg(ORG, () => seq.start(ORG, dealerId, initialId));
      await seq.cancel(ORG, dealerId);

      const job = await inspectQueue.getJob(`seq.${ORG}.${dealerId}.1`);
      assert.equal(job, undefined, 'the delayed job is actually removed, not merely marked');

      await new Promise((r) => setTimeout(r, WAIT_MS));
      assert.equal(await followUpCount(dealerId), 1, 'no follow-up was drafted');
    } finally {
      await seq.onModuleDestroy();
    }
  });
});

describe('halting is guaranteed by the database, not merely by queue removal (§6)', () => {
  // Each case here deliberately does NOT call cancel() — the delayed job is left in
  // place and WILL be picked up by the worker. Only a database fact (pipeline stage,
  // consent, a later touch) stops the send, proving the guarantee is not "best effort".

  test('pipeline stage moved off NEW (a human reply already happened) halts the follow-up', async () => {
    const dealerId = 'seq-db-replied';
    await mkDealer(dealerId);
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'replied@example.com', isPrimary: true, verificationStatus: 'VALID' } });
    const initialId = await initialSend(dealerId);

    const { seq } = newSequenceService();
    try {
      await runWithOrg(ORG, () => seq.start(ORG, dealerId, initialId));
      // The job is still scheduled — no cancel() call. Only the DB changes.
      await raw.dealer.update({ where: { id: dealerId }, data: { pipelineStage: 'CONTACTED' } });

      await new Promise((r) => setTimeout(r, WAIT_MS));
      assert.equal(await followUpCount(dealerId), 1, 'the worker ran but the DB recheck refused to draft/send');
    } finally {
      await seq.onModuleDestroy();
    }
  });

  test('EMAIL consent flips to OPTED_OUT (bounce/unsubscribe) halts the follow-up', async () => {
    const dealerId = 'seq-db-optedout';
    await mkDealer(dealerId);
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'optedout@example.com', isPrimary: true, verificationStatus: 'VALID' } });
    const initialId = await initialSend(dealerId);

    const { seq } = newSequenceService();
    try {
      await runWithOrg(ORG, () => seq.start(ORG, dealerId, initialId));
      await raw.consentLog.create({ data: { organizationId: ORG, dealerId, channel: 'EMAIL', state: 'OPTED_OUT', source: 'BOUNCE' } });

      await new Promise((r) => setTimeout(r, WAIT_MS));
      assert.equal(await followUpCount(dealerId), 1);
    } finally {
      await seq.onModuleDestroy();
    }
  });

  test('a CLICKED touch after the initial send halts the follow-up', async () => {
    const dealerId = 'seq-db-clicked';
    await mkDealer(dealerId);
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'clicked@example.com', isPrimary: true, verificationStatus: 'VALID' } });
    const initialId = await initialSend(dealerId);

    const { seq } = newSequenceService();
    try {
      await runWithOrg(ORG, () => seq.start(ORG, dealerId, initialId));
      await raw.interactionEvent.create({
        data: { organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', status: 'CLICKED', body: '' },
      });

      await new Promise((r) => setTimeout(r, WAIT_MS));
      assert.equal(await followUpCount(dealerId), 1);
    } finally {
      await seq.onModuleDestroy();
    }
  });

  test('an INBOUND touch after the initial send halts the follow-up', async () => {
    const dealerId = 'seq-db-inbound';
    await mkDealer(dealerId);
    await raw.dealerEmail.create({ data: { dealerId, organizationId: ORG, address: 'inbound@example.com', isPrimary: true, verificationStatus: 'VALID' } });
    const initialId = await initialSend(dealerId);

    const { seq } = newSequenceService();
    try {
      await runWithOrg(ORG, () => seq.start(ORG, dealerId, initialId));
      await raw.interactionEvent.create({
        data: { organizationId: ORG, dealerId, channel: 'EMAIL', direction: 'INBOUND', status: 'REPLIED', body: 'an auto-reply, still a touch' },
      });

      await new Promise((r) => setTimeout(r, WAIT_MS));
      assert.equal(await followUpCount(dealerId), 1);
    } finally {
      await seq.onModuleDestroy();
    }
  });
});
