// §1.4 / §10.5 / §13 — "numbers come from the database, never from the model", the
// single most damaging class of error the system can produce.
//
// Real Postgres, real tenancy client, no network: the AIProvider is the deterministic
// fake (§1.7 is what makes that a one-line substitution).
import '../support';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { runWithOrg, withTenancy } from '../../src/core/tenancy/tenancy';
import { FakeAIProvider } from '../../src/providers/ai/fake.provider';
import { AutoSendRule } from '../../src/core/approval/auto-send';
import { DraftingService } from '../../src/core/drafting/drafting.service';
import {
  DraftingError,
  date,
  money,
  percent,
  quantity,
  render,
  template,
  text,
} from '../../src/core/drafting/variables';

const raw = new PrismaClient();
const scoped = withTenancy(new PrismaClient());

const ORG = 'draft-org';
const DEALER = 'draft-dealer';

const RULES: AutoSendRule[] = [
  { id: 'cold-email-no-money', sourceModule: 'outreach-email' },
  { id: 'dormancy-nudge', sourceModule: 'dormancy' },
];

/** One service wired to a model that says exactly what the test tells it to. */
const withModel = (reply?: string) =>
  new DraftingService(scoped as unknown as PrismaClient, new FakeAIProvider(reply), RULES);

before(async () => {
  await raw.organization.create({ data: { id: ORG, name: 'Draft Co', slug: ORG } });
  await raw.dealer.create({
    data: { id: DEALER, organizationId: ORG, businessName: 'Draft Traders', source: 'MANUAL' },
  });
});

after(async () => {
  await raw.$disconnect();
  await scoped.$disconnect();
});

// ---------------------------------------------------------------------------
// The locks that make a free-text number inexpressible
// ---------------------------------------------------------------------------

describe('§1.4 — a number cannot be expressed as free text', () => {
  test('template() refuses a digit outside a placeholder', () => {
    assert.throws(() => template('Your balance of 5000 is overdue'), DraftingError);
    // Devanagari and Arabic-Indic digits are digits too.
    assert.throws(() => template('Your balance of ५००० is overdue'), DraftingError);
    assert.throws(() => template('Your balance of ٥٠٠٠ is overdue'), DraftingError);
  });

  // FINDING 1 — `\p{Nd}` is decimal digits only. Roman numerals (Nl), fractions,
  // superscripts, subscripts and circled digits (No) are numbers a dealer reads as
  // numbers, so they must be as unsayable as "5000".
  const NON_DECIMAL = ['⁵⁰⁰⁰', 'Ⅹ', '½', '①', '²', '₅₀₀₀', 'Ⅻ', '¾'];

  test('template() refuses non-decimal numerals too', () => {
    for (const glyph of NON_DECIMAL) {
      assert.throws(() => template(`Pay ₹${glyph} lakh`), DraftingError, glyph);
    }
  });

  test('the prose variable refuses non-decimal numerals too', () => {
    for (const glyph of NON_DECIMAL) {
      assert.throws(() => text(`about ${glyph} lakh`), DraftingError, glyph);
    }
  });

  test('template() accepts the same sentence with the number as a slot', () => {
    assert.equal(
      template('Your balance of {{amountDue}} is overdue'),
      'Your balance of {{amountDue}} is overdue',
    );
  });

  test('the prose variable refuses a digit — the one slot that could smuggle one', () => {
    assert.throws(() => text('invoice INV2026'), DraftingError);
    assert.deepEqual(text('Mr Sharma'), { kind: 'text', value: 'Mr Sharma' });
  });

  test('money() takes whole paise, not a formatted amount or a rounded rupee float', () => {
    assert.throws(() => money(1234.5), DraftingError);
    assert.throws(() => money(Number.NaN), DraftingError);
  });
});

describe('rendering is deterministic and in code', () => {
  test('money, quantity, percent and date render to fixed strings', () => {
    assert.equal(
      render('{{a}} {{b}} {{c}} {{d}} {{e}}', {
        a: money(12_345_678),
        b: quantity(1500, 'cartons'),
        c: percent(12.5),
        // A fractional value keeps two places; a whole one keeps none.
        d: date(new Date('2026-09-05T00:00:00Z')),
        e: text('Sharma Traders'),
      }),
      '₹1,23,456.78 1,500 cartons 12.50% 05 Sep 2026 Sharma Traders',
    );
  });

  test('Indian grouping, not thousands grouping', () => {
    assert.equal(render('{{a}}', { a: money(1_00_00_000_00) }), '₹1,00,00,000.00');
  });
});

// ---------------------------------------------------------------------------
// The happy path, end to end, against the database
// ---------------------------------------------------------------------------

describe('DraftingService.draft', () => {
  test('the persisted text carries the DB values character for character', async () => {
    const draft = await runWithOrg(ORG, () =>
      withModel(
        'Namaste {{name}}, a friendly reminder that {{amountDue}} was due on {{dueDate}}.',
      ).draft({
        dealerId: DEALER,
        sourceModule: 'collections',
        template: template('{{name}}: {{amountDue}} due {{dueDate}}'),
        variables: {
          name: text('Sharma Traders'),
          amountDue: money(4_57_320_00),
          dueDate: date(new Date('2026-08-14T00:00:00Z')),
        },
      }),
    );

    assert.equal(
      draft.draftText,
      'Namaste Sharma Traders, a friendly reminder that ₹4,57,320.00 was due on 14 Aug 2026.',
    );
    // And the row on disk says the same thing.
    const stored = await raw.messageDraft.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(stored.draftText, draft.draftText);
    assert.equal(stored.status, 'PENDING');
    // §1.4 — the DB values travel with the draft, so the number is traceable.
    assert.deepEqual((stored.templateVariables as any).amountDue, {
      kind: 'money',
      amountPaise: 4_57_320_00,
    });
  });

  test('the model is never shown a value — only the skeleton', async () => {
    const fake = new FakeAIProvider();
    const svc = new DraftingService(scoped as unknown as PrismaClient, fake, RULES);
    await runWithOrg(ORG, () =>
      svc.draft({
        dealerId: DEALER,
        sourceModule: 'collections',
        template: template('Balance {{amountDue}} pending.'),
        variables: { amountDue: money(9_99_999_00) },
      }),
    );
    const seen = fake.calls[0].system + fake.calls[0].prompt;
    assert.equal(/\p{Nd}/u.test(seen.replace(/\{\{[a-zA-Z_]+\}\}/g, '')), false);
    assert.equal(seen.includes('999'), false);
  });

  test('a template placeholder with no variable is refused before the model is called', async () => {
    const fake = new FakeAIProvider();
    await assert.rejects(
      runWithOrg(ORG, () =>
        new DraftingService(scoped as unknown as PrismaClient, fake, RULES).draft({
          dealerId: DEALER,
          sourceModule: 'collections',
          template: template('You owe {{amountDue}}'),
          variables: {},
        }),
      ),
      DraftingError,
    );
    assert.equal(fake.calls.length, 0);
  });

  test('an unused variable is refused — the amount the caller meant is missing', async () => {
    await assert.rejects(
      runWithOrg(ORG, () =>
        withModel().draft({
          dealerId: DEALER,
          sourceModule: 'collections',
          template: template('Hello {{name}}'),
          variables: { name: text('Sharma'), amountDue: money(100) },
        }),
      ),
      DraftingError,
    );
  });
});

// ---------------------------------------------------------------------------
// Adversarial: a hostile model cannot corrupt a number (§10.5)
// ---------------------------------------------------------------------------

describe('a hostile model response cannot reach a dealer', () => {
  const request = {
    dealerId: DEALER,
    sourceModule: 'collections' as const,
    template: template('Your outstanding {{amountDue}} was due on {{dueDate}}.'),
    variables: {
      amountDue: money(4_57_320_00),
      dueDate: date(new Date('2026-08-14T00:00:00Z')),
    },
  };

  const refuses = (name: string, hostile: string) =>
    test(name, async () => {
      const before = await raw.messageDraft.count({ where: { organizationId: ORG } });
      await assert.rejects(
        runWithOrg(ORG, () => withModel(hostile).draft(request)),
        DraftingError,
      );
      // Nothing persisted — §1.5's boundary is not crossed by a bad draft.
      assert.equal(await raw.messageDraft.count({ where: { organizationId: ORG } }), before);
    });

  // States its own number alongside the real one.
  refuses(
    'states a number of its own',
    'Your outstanding {{amountDue}} (approx. 4.5 lakh) was due on {{dueDate}}.',
  );

  // Rewrites the supplied slot into a literal amount of its choosing.
  refuses(
    'replaces a supplied value with an invented one',
    'Your outstanding ₹9,99,999.00 was due on {{dueDate}}.',
  );

  // Invents an extra charge that no database field backs.
  refuses(
    'invents an extra placeholder',
    'Your outstanding {{amountDue}} plus {{lateFee}} was due on {{dueDate}}.',
  );

  // Repeats the amount — a doubled figure reads as a second invoice.
  refuses(
    'repeats a supplied placeholder',
    'Your outstanding {{amountDue}} was due on {{dueDate}}. Please pay {{amountDue}} {{amountDue}}.',
  );

  // Silently drops the amount, leaving a reminder with no figure at all.
  refuses('drops a supplied placeholder', 'Your payment was due on {{dueDate}}.');

  // A date the model felt like offering.
  refuses(
    'writes a date of its own',
    'Your outstanding {{amountDue}} was due on {{dueDate}} (15 August).',
  );

  refuses('returns nothing', '   ');

  // FINDING 3 — both numbers are from the database, and both are attached to the
  // wrong noun. A per-name tally cannot see this; only order can.
  refuses(
    'swaps two supplied placeholders around',
    'Your outstanding {{dueDate}} was due on {{amountDue}}.',
  );

  // FINDING 2 — no digit is written, every placeholder is present in order, and a
  // bidi-aware client still renders ₹4,57,320.00 backwards.
  for (const [name, ctrl] of [
    ['right-to-left override', '‮'],
    ['isolate', '⁦'],
    ['zero-width space', '​'],
  ] as const) {
    refuses(
      `smuggles a ${name} control character`,
      `Your outstanding ${ctrl}{{amountDue}}‬ was due on {{dueDate}}.`,
    );
  }

  // FINDING 1 — Nl (Roman numerals) and No (fractions, superscripts, circled digits)
  // are numbers that `\p{Nd}` alone waves through.
  for (const glyph of ['⁵⁰⁰⁰', 'Ⅹ', '½', '①', '²', '₅₀₀₀', 'Ⅻ', '¾']) {
    refuses(
      `writes a non-decimal numeral of its own (${glyph})`,
      `Your outstanding {{amountDue}} (about ${glyph} lakh) was due on {{dueDate}}.`,
    );
  }

  test('a well-behaved rewrite still renders only DB values', async () => {
    const draft = await runWithOrg(ORG, () =>
      withModel('Gentle reminder: {{amountDue}} has been outstanding since {{dueDate}}.').draft(
        request,
      ),
    );
    assert.equal(
      draft.draftText,
      'Gentle reminder: ₹4,57,320.00 has been outstanding since 14 Aug 2026.',
    );
  });
});

// ---------------------------------------------------------------------------
// containsFinancialTerms / requiresApproval — deterministic, never asked of the model
// ---------------------------------------------------------------------------

describe('containsFinancialTerms is derived from the variables', () => {
  const draftWith = (sourceModule: string, variables: any, tpl: string, reply: string) =>
    runWithOrg(ORG, () =>
      withModel(reply).draft({ dealerId: DEALER, sourceModule, template: template(tpl), variables }),
    );

  test('money makes it true even when the model insists the message is harmless', async () => {
    const d = await draftWith(
      'dormancy',
      { amountDue: money(1_000_00) },
      'Credit note {{amountDue}}.',
      'No financial terms here at all: {{amountDue}}.',
    );
    assert.equal(d.containsFinancialTerms, true);
  });

  // FINDING 4 — a discount and a free-goods quantity are financial commitments
  // (§5.7). A draft carrying one must never skip the queue, whatever the module rule
  // says: containsFinancialTerms and requiresApproval must not disagree.
  test('quantity and percent count as financial terms — and pull a human in', async () => {
    const q = await draftWith('dormancy', { qty: quantity(40, 'boxes') }, 'Reorder {{qty}}.', 'Reorder {{qty}}.');
    assert.deepEqual([q.containsFinancialTerms, q.requiresApproval, q.autoSendRuleId], [true, true, null]);
    const p = await draftWith('dormancy', { off: percent(5) }, 'Save {{off}}.', 'Save {{off}}.');
    assert.deepEqual([p.containsFinancialTerms, p.requiresApproval, p.autoSendRuleId], [true, true, null]);
  });

  test('a percent or quantity commitment never auto-sends from cold email either (§5.7)', async () => {
    const off = await draftWith('outreach-email', { off: percent(40) }, 'Enjoy {{off}} off this month.', 'Enjoy {{off}} off this month.');
    assert.deepEqual([off.containsFinancialTerms, off.requiresApproval, off.autoSendRuleId], [true, true, null]);
    const free = await draftWith(
      'outreach-email',
      { qty: quantity(500, 'boxes') },
      'Free {{qty}} with every order.',
      'Free {{qty}} with every order.',
    );
    assert.deepEqual([free.containsFinancialTerms, free.requiresApproval, free.autoSendRuleId], [true, true, null]);
  });

  test('containsFinancialTerms and requiresApproval never disagree', async () => {
    const financial = await draftWith('dormancy', { a: money(1) }, 'Due {{a}}.', 'Due {{a}}.');
    assert.deepEqual([financial.containsFinancialTerms, financial.requiresApproval], [true, true]);
  });

  test('prose and dates alone are not financial terms', async () => {
    const d = await draftWith(
      'outreach-email',
      { name: text('Sharma Traders'), when: date(new Date('2026-09-01T00:00:00Z')) },
      'Hello {{name}}, visiting {{when}}.',
      'Hello {{name}}, visiting {{when}}.',
    );
    assert.equal(d.containsFinancialTerms, false);
  });

  test('any financial term requires a human, however small (§5.7)', async () => {
    for (const paise of [1, 4_999_999, 5_000_000, 5_000_001]) {
      const d = await draftWith('dormancy', { a: money(paise) }, 'Due {{a}}.', 'Due {{a}}.');
      assert.deepEqual([d.requiresApproval, d.autoSendRuleId], [true, null], String(paise));
    }
  });

  test('a module rule auto-sends only a draft with no financial term in it at all', async () => {
    const d = await draftWith(
      'dormancy',
      { name: text('Sharma'), when: date(new Date('2026-09-01T00:00:00Z')) },
      'Hi {{name}}, back on {{when}}?',
      'Hi {{name}}, back on {{when}}?',
    );
    assert.deepEqual([d.requiresApproval, d.autoSendRuleId], [false, 'dormancy-nudge']);
  });

  test('a module with no rule always requires a human', async () => {
    const d = await draftWith('schemes', { name: text('Sharma') }, 'Hi {{name}}.', 'Hi {{name}}.');
    assert.equal(d.requiresApproval, true);
    assert.equal(d.autoSendRuleId, null);
  });

  test('cold email auto-sends only while it carries no money (§5.2)', async () => {
    const plain = await draftWith(
      'outreach-email',
      { name: text('Sharma') },
      'Hi {{name}}.',
      'Hi {{name}}.',
    );
    assert.equal(plain.requiresApproval, false);
    const priced = await draftWith(
      'outreach-email',
      { a: money(1) },
      'Offer {{a}}.',
      'Offer {{a}}.',
    );
    assert.equal(priced.requiresApproval, true);
  });
});

describe('§1.3 — drafting is org-scoped like everything else', () => {
  test('drafting without a context fails rather than leaking', async () => {
    await assert.rejects(
      withModel('Hi {{name}}.').draft({
        dealerId: DEALER,
        sourceModule: 'outreach-email',
        template: template('Hi {{name}}.'),
        variables: { name: text('Sharma') },
      }),
      /tenancy/i,
    );
  });
});
