// §9 / §12.3 — the Approval Queue's state machine, exhaustively, plus §9's
// "every transition writes an AuditEvent recording who approved it, or which rule
// triggered the auto-send". Real Postgres, real tenancy client, no mocks.
import '../support';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { DraftStatus, Prisma, PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { AuditService } from '../../src/core/audit/audit.service';
import { ApprovalError, ApprovalService } from '../../src/core/approval/approval.service';
import { AutoSendRule, autoSendRuleFor } from '../../src/core/approval/auto-send';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());
const audit = new AuditService(scoped as unknown as PrismaClient);

const RULES: AutoSendRule[] = [
  { id: 'cold-email-no-money', sourceModule: 'outreach-email', maxValuePaise: 0 },
  { id: 'dormancy-under-50k', sourceModule: 'dormancy', maxValuePaise: 5_000_000 },
];

const queue = new ApprovalService(scoped as unknown as PrismaClient, audit, RULES);

const ORG_A = 'approval-org-a';
const ORG_B = 'approval-org-b';
const DEALER_A1 = 'approval-dealer-a1';
const DEALER_A2 = 'approval-dealer-a2';
const DEALER_B = 'approval-dealer-b';
const USER = 'approval-user';

let seq = 0;
async function mkDraft(
  overrides: Partial<Prisma.MessageDraftUncheckedCreateInput> = {},
): Promise<string> {
  const id = `approval-draft-${seq++}`;
  await raw.messageDraft.create({
    data: {
      id,
      organizationId: ORG_A,
      dealerId: DEALER_A1,
      sourceModule: 'collections',
      draftText: 'Gentle reminder.',
      ...overrides,
    },
  });
  return id;
}

const statusOf = async (id: string) =>
  (await raw.messageDraft.findUniqueOrThrow({ where: { id } })).status;

const eventsFor = (id: string) =>
  raw.auditEvent.findMany({ where: { entityType: 'MessageDraft', entityId: id } });

before(async () => {
  await raw.organization.createMany({
    data: [
      { id: ORG_A, name: 'Approval A', slug: ORG_A },
      { id: ORG_B, name: 'Approval B', slug: ORG_B },
    ],
  });
  await raw.dealer.createMany({
    data: [
      { id: DEALER_A1, organizationId: ORG_A, businessName: 'A One Traders', source: 'MANUAL' },
      { id: DEALER_A2, organizationId: ORG_A, businessName: 'A Two Traders', source: 'MANUAL' },
      { id: DEALER_B, organizationId: ORG_B, businessName: 'B Traders', source: 'MANUAL' },
    ],
  });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

// ---------------------------------------------------------------------------
// The queue itself
// ---------------------------------------------------------------------------

describe('pending drafts, grouped by dealer, across modules (§9)', () => {
  beforeEach(async () => {
    // Scoped: node:test runs test FILES in parallel processes against one database,
    // so a bare deleteMany here would delete the drafting suite's rows mid-assertion.
    await raw.messageDraft.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  });

  test('groups by dealer and carries the business name', async () => {
    await mkDraft({ dealerId: DEALER_A1, sourceModule: 'collections' });
    await mkDraft({ dealerId: DEALER_A1, sourceModule: 'dormancy' });
    await mkDraft({ dealerId: DEALER_A2, sourceModule: 'schemes' });

    const groups = await runWithOrg(ORG_A, () => queue.pending());
    assert.deepEqual(
      groups.map((g) => [g.dealerId, g.businessName, g.drafts.length]),
      [
        [DEALER_A1, 'A One Traders', 2],
        [DEALER_A2, 'A Two Traders', 1],
      ],
    );
  });

  test('only PENDING rows appear', async () => {
    await mkDraft({ status: DraftStatus.APPROVED });
    await mkDraft({ status: DraftStatus.REJECTED });
    await mkDraft({ status: DraftStatus.AUTO_SENT });
    const pending = await mkDraft();
    const groups = await runWithOrg(ORG_A, () => queue.pending());
    assert.deepEqual(groups.flatMap((g) => g.drafts.map((d) => d.id)), [pending]);
  });

  test('a module filter narrows it without a second queue', async () => {
    await mkDraft({ sourceModule: 'collections' });
    const dormancy = await mkDraft({ sourceModule: 'dormancy' });
    const groups = await runWithOrg(ORG_A, () => queue.pending({ sourceModule: 'dormancy' }));
    assert.deepEqual(groups.flatMap((g) => g.drafts.map((d) => d.id)), [dormancy]);
  });
});

// ---------------------------------------------------------------------------
// §12.3 — the state machine, every legal and illegal edge
// ---------------------------------------------------------------------------

describe('legal transitions out of PENDING', () => {
  test('approve → APPROVED, audited to the approver (§9)', async () => {
    const id = await mkDraft();
    const draft = await runWithOrg(ORG_A, () => queue.approve(id, USER));
    assert.equal(draft.status, DraftStatus.APPROVED);
    assert.equal(draft.approvedByUserId, USER);

    const [event, ...rest] = await eventsFor(id);
    assert.equal(rest.length, 0);
    assert.equal(event.action, 'DRAFT_APPROVED');
    assert.equal(event.actorType, 'USER');
    assert.equal(event.actorId, USER);
    assert.equal(event.organizationId, ORG_A);
    assert.equal((event.metadata as any).approvedByUserId, USER);
  });

  test('editAndApprove → APPROVED, with the previous text in the audit row', async () => {
    const id = await mkDraft({ draftText: 'Original wording.' });
    const draft = await runWithOrg(ORG_A, () =>
      queue.editAndApprove(id, USER, 'Rewritten by a human.'),
    );
    assert.equal(draft.status, DraftStatus.APPROVED);
    assert.equal(draft.draftText, 'Rewritten by a human.');

    const [event] = await eventsFor(id);
    assert.equal(event.actorId, USER);
    assert.equal((event.metadata as any).edited, true);
    assert.equal((event.metadata as any).previousText, 'Original wording.');
  });

  test('editAndApprove refuses empty text and changes nothing', async () => {
    const id = await mkDraft({ draftText: 'Original wording.' });
    await assert.rejects(runWithOrg(ORG_A, () => queue.editAndApprove(id, USER, '  ')), ApprovalError);
    assert.equal(await statusOf(id), DraftStatus.PENDING);
    assert.equal((await eventsFor(id)).length, 0);
  });

  test('reject → REJECTED, audited to the rejecter with the reason', async () => {
    const id = await mkDraft();
    const draft = await runWithOrg(ORG_A, () => queue.reject(id, USER, 'tone is wrong'));
    assert.equal(draft.status, DraftStatus.REJECTED);

    const [event] = await eventsFor(id);
    assert.equal(event.action, 'DRAFT_REJECTED');
    assert.equal(event.actorId, USER);
    assert.equal((event.metadata as any).reason, 'tone is wrong');
  });

  test('autoSend → APPROVED, audited to the RULE, with no human credited (§9)', async () => {
    const id = await mkDraft({
      sourceModule: 'dormancy',
      requiresApproval: false,
      autoSendRuleId: 'dormancy-under-50k',
    });
    const draft = await runWithOrg(ORG_A, () => queue.autoSend(id));
    assert.equal(draft.status, DraftStatus.APPROVED);
    assert.equal(draft.approvedByUserId, null);

    const [event] = await eventsFor(id);
    assert.equal(event.action, 'DRAFT_AUTO_SENT');
    assert.equal(event.actorType, 'SYSTEM');
    assert.equal(event.actorId, null);
    assert.equal((event.metadata as any).autoSendRuleId, 'dormancy-under-50k');
  });
});

describe('autoSend refuses anything a rule does not actually cover', () => {
  test('a draft that requires approval cannot be auto-sent', async () => {
    const id = await mkDraft({ requiresApproval: true, autoSendRuleId: 'dormancy-under-50k' });
    await assert.rejects(runWithOrg(ORG_A, () => queue.autoSend(id)), ApprovalError);
    assert.equal(await statusOf(id), DraftStatus.PENDING);
    assert.equal((await eventsFor(id)).length, 0);
  });

  test('a draft naming a rule that does not exist cannot be auto-sent', async () => {
    const id = await mkDraft({ requiresApproval: false, autoSendRuleId: 'invented-rule' });
    await assert.rejects(runWithOrg(ORG_A, () => queue.autoSend(id)), ApprovalError);
    assert.equal(await statusOf(id), DraftStatus.PENDING);
  });

  test('a draft naming no rule at all cannot be auto-sent', async () => {
    const id = await mkDraft({ requiresApproval: false, autoSendRuleId: null });
    await assert.rejects(runWithOrg(ORG_A, () => queue.autoSend(id)), ApprovalError);
    assert.equal(await statusOf(id), DraftStatus.PENDING);
  });
});

describe('illegal transitions — PENDING is the only decidable state (§12.3)', () => {
  const terminal = [
    DraftStatus.APPROVED,
    DraftStatus.REJECTED,
    DraftStatus.AUTO_SENT,
    DraftStatus.EDITED_AND_SENT,
  ];

  for (const status of terminal) {
    for (const [name, run] of [
      ['approve', (id: string) => queue.approve(id, USER)],
      ['editAndApprove', (id: string) => queue.editAndApprove(id, USER, 'second thoughts')],
      ['reject', (id: string) => queue.reject(id, USER)],
      ['autoSend', (id: string) => queue.autoSend(id)],
    ] as [string, (id: string) => Promise<unknown>][]) {
      test(`${name} on a ${status} draft is refused and changes nothing`, async () => {
        const id = await mkDraft({
          status,
          draftText: 'Already decided.',
          // Auto-send eligible, so the refusal is about the STATE and nothing else.
          requiresApproval: false,
          autoSendRuleId: 'dormancy-under-50k',
          sourceModule: 'dormancy',
        });
        await assert.rejects(runWithOrg(ORG_A, () => run(id)), ApprovalError);
        assert.equal(await statusOf(id), status);
        assert.equal((await raw.messageDraft.findUniqueOrThrow({ where: { id } })).draftText, 'Already decided.');
        assert.equal((await eventsFor(id)).length, 0);
      });
    }
  }

  test('a decided draft cannot be decided twice', async () => {
    const id = await mkDraft();
    await runWithOrg(ORG_A, () => queue.approve(id, USER));
    await assert.rejects(runWithOrg(ORG_A, () => queue.reject(id, USER)), ApprovalError);
    assert.equal(await statusOf(id), DraftStatus.APPROVED);
    // Exactly one audit row: the audit trail is not the place a double-decision hides.
    assert.equal((await eventsFor(id)).length, 1);
  });

  test('an unknown draft id is refused', async () => {
    await assert.rejects(runWithOrg(ORG_A, () => queue.approve('no-such-draft', USER)), ApprovalError);
  });
});

// ---------------------------------------------------------------------------
// §1.3 — org scoping
// ---------------------------------------------------------------------------

describe('another org’s draft is invisible and un-approvable (§1.3)', () => {
  test('it does not appear in the queue, and cannot be approved or rejected', async () => {
    const mine = await mkDraft({ dealerId: DEALER_A1 });
    const theirs = await mkDraft({ organizationId: ORG_B, dealerId: DEALER_B });

    const groups = await runWithOrg(ORG_A, () => queue.pending());
    const ids = groups.flatMap((g) => g.drafts.map((d) => d.id));
    assert.equal(ids.includes(mine), true);
    assert.equal(ids.includes(theirs), false);

    await assert.rejects(runWithOrg(ORG_A, () => queue.approve(theirs, USER)), ApprovalError);
    await assert.rejects(runWithOrg(ORG_A, () => queue.reject(theirs, USER)), ApprovalError);
    assert.equal(await statusOf(theirs), DraftStatus.PENDING);
    assert.equal((await eventsFor(theirs)).length, 0);
  });

  test('no org context at all fails rather than leaking', async () => {
    const id = await mkDraft();
    await assert.rejects(queue.pending(), /tenancy/i);
    await assert.rejects(queue.approve(id, USER), /tenancy/i);
  });
});

// ---------------------------------------------------------------------------
// §9 — the auto-send threshold, at / below / above the boundary
// ---------------------------------------------------------------------------

describe('auto-send thresholds are per module and deterministic', () => {
  test('below, at and above 50k', () => {
    const at = (paise: number) => autoSendRuleFor(RULES, 'dormancy', paise)?.id ?? null;
    assert.equal(at(4_999_999), 'dormancy-under-50k');
    assert.equal(at(5_000_000), 'dormancy-under-50k');
    assert.equal(at(5_000_001), null);
  });

  test('a rule never applies to another module', () => {
    assert.equal(autoSendRuleFor(RULES, 'collections', 0), null);
    assert.equal(autoSendRuleFor(RULES, 'outreach-email', 0)?.id, 'cold-email-no-money');
    assert.equal(autoSendRuleFor(RULES, 'outreach-email', 1), null);
  });

  test('no rules configured means nothing auto-sends', () => {
    assert.equal(autoSendRuleFor([], 'outreach-email', 0), null);
  });
});
