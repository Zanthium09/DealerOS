// The "give the AI free-text context, it writes the email" feature the user asked
// for, built as a sibling to the templated drafting path rather than a modification
// of it. §1.4 still has to hold here: the brief may say anything (it's instructions,
// never sent to a dealer), but the model's OUTPUT is checked exactly like every
// other AI-written text in this app — one digit anywhere rejects the whole draft.
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { FakeAIProvider } from '../../src/providers/ai/fake.provider';
import { CustomDraftService } from '../../src/modules/outreach-email/custom-draft.service';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());

const ORG = 'custom-draft-org';

const withModel = (reply: string) => new CustomDraftService(scoped as unknown as PrismaClient, new FakeAIProvider(reply));

/** A fresh dealer per test that checks draft counts — sharing one dealer across
 *  sequential tests would let an earlier test's successful draft masquerade as
 *  evidence for a later test's "nothing was saved" assertion. */
async function newDealer(id: string): Promise<string> {
  await raw.dealer.create({ data: { id, organizationId: ORG, businessName: `Dealer ${id}`, contactPersonName: 'Vikram Sharma', source: 'MANUAL' } });
  return id;
}

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Custom Draft Traders', slug: ORG } });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('CustomDraftService (§1.4 on a free-form path)', () => {
  test('a clean, digit-free model response is saved and always requires approval', async () => {
    const dealer = await newDealer('cd-dealer-clean');
    const svc = withModel(
      'Hi Vikram, hope business is going well at Sharma Hardware. We would love to catch up soon — let us know a good time to call.',
    );
    const draft = await runWithOrg(ORG, () => svc.draft(dealer, 'Ask Vikram for a quick call to catch up, friendly tone.'));

    assert.equal(draft.dealerId, dealer);
    assert.equal(draft.sourceModule, 'outreach-email');
    assert.equal(draft.status, 'PENDING');
    assert.equal(draft.requiresApproval, true, 'custom drafts never skip the queue, regardless of content');
    assert.equal(draft.containsFinancialTerms, false);
    assert.match(draft.draftText, /Vikram/);
  });

  test('a digit anywhere in the model output rejects the whole draft — nothing is saved', async () => {
    const dealer = await newDealer('cd-dealer-digit');
    const svc = withModel('Hi Vikram, we would love to offer you 20% off this month at Sharma Hardware.');
    await assert.rejects(
      () => runWithOrg(ORG, () => svc.draft(dealer, 'Mention our 20% off scheme this month.')),
      /digit/i,
    );
    const count = await raw.messageDraft.count({ where: { organizationId: ORG, dealerId: dealer } });
    assert.equal(count, 0, 'a rejected draft must leave nothing behind');
  });

  test('a non-decimal numeral (Roman numeral, superscript, fullwidth) is caught too, not just 0-9', async () => {
    const dealer = await newDealer('cd-dealer-unicode');
    for (const hostile of ['Please call us by Ⅴ pm.', 'See you in ⁵ days.', 'That will be ready by day ５.']) {
      const svc = withModel(hostile);
      await assert.rejects(() => runWithOrg(ORG, () => svc.draft(dealer, 'Just checking in.')), /digit/i);
    }
    const count = await raw.messageDraft.count({ where: { organizationId: ORG, dealerId: dealer } });
    assert.equal(count, 0);
  });

  test("the brief itself may contain numbers freely — only the model's OUTPUT is checked", async () => {
    const dealer = await newDealer('cd-dealer-brief-numbers');
    // The brief says "20% off" — that is an instruction to the model, never sent to
    // a dealer. A clean, number-free response to it must be accepted.
    const svc = withModel('Hi Vikram, we have an exciting offer running this month at Sharma Hardware — worth a call!');
    const draft = await runWithOrg(ORG, () => svc.draft(dealer, 'We are running a 20% off scheme — mention it without stating the figure.'));
    assert.equal(draft.status, 'PENDING');
  });

  test('an empty or whitespace-only brief is rejected before the model is ever called', async () => {
    const dealer = await newDealer('cd-dealer-empty-brief');
    let called = false;
    const ai = { complete: async () => ((called = true), 'unused') };
    const svc = new CustomDraftService(scoped as unknown as PrismaClient, ai as never);
    await assert.rejects(() => runWithOrg(ORG, () => svc.draft(dealer, '   ')));
    assert.equal(called, false, 'no point spending a model call on an empty brief');
  });

  test('an unknown dealer id is refused', async () => {
    const svc = withModel('irrelevant');
    await assert.rejects(() => runWithOrg(ORG, () => svc.draft('no-such-dealer', 'hello')), /no dealer/i);
  });

  test('§1.3 — drafting without an org context fails rather than leaking', async () => {
    const dealer = await newDealer('cd-dealer-no-context');
    const svc = withModel('Hi there.');
    await assert.rejects(() => svc.draft(dealer, 'hello'));
  });

  test('org scoping: a dealer from another org cannot be drafted for', async () => {
    const OTHER_ORG = 'custom-draft-other-org';
    const OTHER_DEALER = 'custom-draft-other-dealer';
    await raw.organization.create({ data: { id: OTHER_ORG, name: 'Other Org', slug: OTHER_ORG } });
    await raw.dealer.create({
      data: { id: OTHER_DEALER, organizationId: OTHER_ORG, businessName: 'Other Traders', source: 'MANUAL' },
    });
    const svc = withModel('Hi there.');
    await assert.rejects(() => runWithOrg(ORG, () => svc.draft(OTHER_DEALER, 'hello')), /no dealer/i);
  });
});
