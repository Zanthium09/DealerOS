// §6 / §13 — the send-time guards. Real Postgres, FakeEmailProvider (no network).
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { EmailSendError, EmailSendService } from '../../src/modules/outreach-email/send.service';
import { AlwaysAllowThrottle, NeverPausedKillSwitch } from '../../src/modules/outreach-email/ports';
import { FakeEmailProvider } from '../../src/providers/email';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());

const ORG = 'send-org';
const DEALER = 'send-dealer';
const DOMAIN = 'mail-send-org.in';

const CONFIG = { unsubscribeSecret: 'test-unsubscribe-secret', publicBaseUrl: 'https://app.test' };

function service(email = new FakeEmailProvider()) {
  return {
    email,
    svc: new EmailSendService(
      scoped as unknown as PrismaClient,
      email,
      new AlwaysAllowThrottle(),
      new NeverPausedKillSwitch(),
      CONFIG,
    ),
  };
}

let seq = 0;
async function mkDraft(overrides: Partial<Prisma.MessageDraftUncheckedCreateInput> = {}): Promise<string> {
  const id = `send-draft-${seq++}`;
  await raw.messageDraft.create({
    data: {
      id,
      organizationId: ORG,
      dealerId: DEALER,
      sourceModule: 'outreach-email',
      draftText: 'Hello, we would love to work with you.',
      status: 'APPROVED',
      ...overrides,
    },
  });
  return id;
}

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Send Co', slug: ORG } });
  await raw.dealer.create({ data: { id: DEALER, organizationId: ORG, businessName: 'Sharma Traders', source: 'MANUAL' } });
  await raw.sendingIdentity.create({
    data: { organizationId: ORG, domain: DOMAIN, provider: 'resend', verificationStatus: 'VERIFIED', currentDailyLimit: 50 },
  });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('sendApprovedDraft — the happy path', () => {
  test('sends via the provider, logs an InteractionEvent, stamps the draft sent', async () => {
    await raw.dealerEmail.create({
      data: { dealerId: DEALER, organizationId: ORG, address: 'owner@sharmatraders.example', isPrimary: true, verificationStatus: 'VALID' },
    });
    const draftId = await mkDraft({ autoSendRuleId: 'cold-email-no-money' });
    const { email, svc } = service();

    const event = await runWithOrg(ORG, () => svc.sendApprovedDraft(draftId));

    assert.equal(event.status, 'SENT');
    assert.equal(event.body, 'Hello, we would love to work with you.');
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0].to, 'owner@sharmatraders.example');
    assert.equal(email.sent[0].from, `hello@${DOMAIN}`);

    // §6 — one-click unsubscribe, header AND link.
    assert.match(email.sent[0].headers['List-Unsubscribe'], /^<https:\/\/app\.test\/outreach-email\/unsubscribe\?token=/);
    assert.equal(email.sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(email.sent[0].headers['Message-ID']);

    const draft = await raw.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
    assert.equal(draft.status, 'AUTO_SENT'); // autoSendRuleId was set
    assert.ok(draft.sentAt);
  });

  test('a human-approved draft (no autoSendRuleId) is stamped EDITED_AND_SENT', async () => {
    await raw.dealerEmail.deleteMany({ where: { dealerId: DEALER } });
    await raw.dealerEmail.create({
      data: { dealerId: DEALER, organizationId: ORG, address: 'owner2@sharmatraders.example', isPrimary: true, verificationStatus: 'VALID' },
    });
    const draftId = await mkDraft({ approvedByUserId: 'some-user' });
    const { svc } = service();
    await runWithOrg(ORG, () => svc.sendApprovedDraft(draftId));
    const draft = await raw.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
    assert.equal(draft.status, 'EDITED_AND_SENT');
  });
});

describe('hard stops that must never send (§6)', () => {
  test('a draft that is not APPROVED is refused', async () => {
    const draftId = await mkDraft({ status: 'PENDING' });
    const { email, svc } = service();
    await assert.rejects(runWithOrg(ORG, () => svc.sendApprovedDraft(draftId)), EmailSendError);
    assert.equal(email.sent.length, 0);
  });

  test('an INVALID email address is never sent to', async () => {
    const dealerId = 'send-dealer-invalid';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: 'Invalid Co', source: 'MANUAL' } });
    await raw.dealerEmail.create({
      data: { dealerId, organizationId: ORG, address: 'bad@invalid.example', isPrimary: true, verificationStatus: 'INVALID' },
    });
    const draftId = await mkDraft({ dealerId });
    const { email, svc } = service();
    await assert.rejects(runWithOrg(ORG, () => svc.sendApprovedDraft(draftId)), /INVALID/);
    assert.equal(email.sent.length, 0);
  });

  test('an address on this org\'s Suppression list is never sent to', async () => {
    const dealerId = 'send-dealer-suppressed';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: 'Suppressed Co', source: 'MANUAL' } });
    await raw.dealerEmail.create({
      data: { dealerId, organizationId: ORG, address: 'stop@suppressed.example', isPrimary: true, verificationStatus: 'VALID' },
    });
    await raw.suppression.create({ data: { organizationId: ORG, email: 'stop@suppressed.example', reason: 'test' } });
    const draftId = await mkDraft({ dealerId });
    const { email, svc } = service();
    await assert.rejects(runWithOrg(ORG, () => svc.sendApprovedDraft(draftId)), /suppression/i);
    assert.equal(email.sent.length, 0);
  });

  test('Suppression is scoped per org — org B\'s suppression does not block org A', async () => {
    const orgB = 'send-org-b-suppression';
    await raw.organization.create({ data: { id: orgB, name: 'Org B', slug: orgB } });
    await raw.suppression.create({ data: { organizationId: orgB, email: 'shared@example.com', reason: 'org B only' } });

    const dealerId = 'send-dealer-shared-email';
    await raw.dealer.create({ data: { id: dealerId, organizationId: ORG, businessName: 'Shared Co', source: 'MANUAL' } });
    await raw.dealerEmail.create({
      data: { dealerId, organizationId: ORG, address: 'shared@example.com', isPrimary: true, verificationStatus: 'VALID' },
    });
    const draftId = await mkDraft({ dealerId });
    const { email, svc } = service();
    await runWithOrg(ORG, () => svc.sendApprovedDraft(draftId));
    assert.equal(email.sent.length, 1, 'org A must still be able to send — org B suppression is not global');
  });

  test('no verified SendingIdentity — refuses to send', async () => {
    const orgNoIdentity = 'send-org-no-identity';
    await raw.organization.create({ data: { id: orgNoIdentity, name: 'No Identity Co', slug: orgNoIdentity } });
    const dealerId = 'send-dealer-no-identity';
    await raw.dealer.create({ data: { id: dealerId, organizationId: orgNoIdentity, businessName: 'X', source: 'MANUAL' } });
    await raw.dealerEmail.create({
      data: { dealerId, organizationId: orgNoIdentity, address: 'x@x.example', isPrimary: true, verificationStatus: 'VALID' },
    });
    const draftId = `send-draft-noid-${seq++}`;
    await raw.messageDraft.create({
      data: { id: draftId, organizationId: orgNoIdentity, dealerId, sourceModule: 'outreach-email', draftText: 'hi', status: 'APPROVED' },
    });
    const { email, svc } = service();
    await assert.rejects(runWithOrg(orgNoIdentity, () => svc.sendApprovedDraft(draftId)), /verified SendingIdentity/);
    assert.equal(email.sent.length, 0);
  });

  test('an unverified (only) identity does not count as verified', async () => {
    const org2 = 'send-org-unverified';
    await raw.organization.create({ data: { id: org2, name: 'Unverified Co', slug: org2 } });
    await raw.sendingIdentity.create({ data: { organizationId: org2, domain: 'mail-unverified.in', provider: 'resend', verificationStatus: 'PENDING' } });
    const dealerId = 'send-dealer-unverified';
    await raw.dealer.create({ data: { id: dealerId, organizationId: org2, businessName: 'Y', source: 'MANUAL' } });
    await raw.dealerEmail.create({ data: { dealerId, organizationId: org2, address: 'y@y.example', isPrimary: true, verificationStatus: 'VALID' } });
    const draftId = `send-draft-unv-${seq++}`;
    await raw.messageDraft.create({ data: { id: draftId, organizationId: org2, dealerId, sourceModule: 'outreach-email', draftText: 'hi', status: 'APPROVED' } });
    const { svc } = service();
    await assert.rejects(runWithOrg(org2, () => svc.sendApprovedDraft(draftId)), /verified SendingIdentity/);
  });

  test('daily cap reached refuses to send (§6 warmup ramp / hard cap)', async () => {
    const org3 = 'send-org-cap';
    await raw.organization.create({ data: { id: org3, name: 'Cap Co', slug: org3 } });
    await raw.sendingIdentity.create({ data: { organizationId: org3, domain: 'mail-cap.in', provider: 'resend', verificationStatus: 'VERIFIED', currentDailyLimit: 1 } });
    const dealerId = 'send-dealer-cap';
    await raw.dealer.create({ data: { id: dealerId, organizationId: org3, businessName: 'Cap Dealer', source: 'MANUAL' } });
    await raw.dealerEmail.create({ data: { dealerId, organizationId: org3, address: 'cap@cap.example', isPrimary: true, verificationStatus: 'VALID' } });
    // Already at the cap for today.
    await raw.interactionEvent.create({
      data: { organizationId: org3, dealerId, channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', body: 'earlier today' },
    });
    const draftId = `send-draft-cap-${seq++}`;
    await raw.messageDraft.create({ data: { id: draftId, organizationId: org3, dealerId, sourceModule: 'outreach-email', draftText: 'hi', status: 'APPROVED' } });
    const { email, svc } = service();
    await assert.rejects(runWithOrg(org3, () => svc.sendApprovedDraft(draftId)), /daily cap/);
    assert.equal(email.sent.length, 0);
  });
});

describe('§1.3 — sending without a context fails rather than leaking', () => {
  test('sendApprovedDraft with no org context throws', async () => {
    const draftId = await mkDraft();
    const { svc } = service();
    await assert.rejects(svc.sendApprovedDraft(draftId), /tenancy/i);
  });
});
