import { Inject, Injectable } from '@nestjs/common';
import { MessageDraft, Prisma, PrismaClient } from '@prisma/client';
import { PRISMA } from '../tenancy/tenancy.module';
import { AI_PROVIDER, AIProvider } from '../../providers/ai/ai.provider';
import { AUTO_SEND_RULES, AutoSendRule, autoSendRuleFor } from '../approval/auto-send';
import {
  DraftVariables,
  DraftingError,
  Template,
  assertNoDigits,
  containsFinancialTerms,
  maxMoneyPaise,
  placeholdersIn,
  render,
} from './variables';

export type DraftRequest = {
  dealerId: string;
  /** Which module asked — drives the auto-send rule (§9) and shows in the queue. */
  sourceModule: string;
  /** The skeleton. Branded: a plain string with an amount in it will not compile. */
  template: Template;
  /** DB-sourced values, one per placeholder. Typed — see variables.ts. */
  variables: DraftVariables;
  /** Optional steer for the model ("firm but not threatening"). Also branded, so the
   *  brief cannot be used to hand the model a number either. */
  brief?: Template;
};

// The model is told what it may do, and then checked on all of it. The instructions
// are courtesy; `assertModelBehaved` is the guarantee (§1.4, §10.5).
const SYSTEM = [
  'You write short, plain business messages for an Indian distribution company,',
  'addressed to its dealers.',
  '',
  'You are given a skeleton containing {{placeholder}} slots. Rewrite it so it reads',
  'naturally. Absolute rules:',
  '- Reproduce every {{placeholder}} exactly as written, the same number of times.',
  '- Never write a digit. Not a figure, not a date, not an amount, not a count.',
  '- Never add, remove, reorder-away or rename a placeholder.',
  '- Output the message only. No preamble, no explanation, no quotes around it.',
].join('\n');

@Injectable()
export class DraftingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
    @Inject(AUTO_SEND_RULES) private readonly rules: readonly AutoSendRule[],
  ) {}

  /**
   * §1.5 — the ONLY way an AI-written message enters the system. Returns a persisted
   * MessageDraft; nothing here sends anything.
   *
   * The model sees the skeleton and never a value, so a number it could invent has
   * nowhere to land: every value is substituted afterwards, in `render`, from the
   * typed variables.
   */
  async draft(request: DraftRequest): Promise<MessageDraft> {
    const wanted = placeholdersIn(request.template);
    const named = Object.keys(request.variables);

    for (const p of wanted) {
      if (!request.variables[p]) throw new DraftingError(`template uses {{${p}}} but no variable was supplied`);
    }
    // Not pedantry: an unused variable usually means the template names the slot
    // differently, i.e. the amount the caller meant to state is silently missing.
    for (const n of named) {
      if (!wanted.includes(n)) throw new DraftingError(`variable "${n}" is never used by the template`);
    }

    const skeleton = await this.ai.complete({
      system: SYSTEM,
      // The skeleton goes last — FakeAIProvider's default echo relies on it, and it is
      // the thing the model is meant to be working on.
      prompt: [
        request.brief ? `Context: ${request.brief}` : null,
        'Skeleton:',
        request.template,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    assertModelBehaved(skeleton, wanted);

    const financial = containsFinancialTerms(request.variables);
    const rule = autoSendRuleFor(this.rules, request.sourceModule, maxMoneyPaise(request.variables));

    return this.prisma.messageDraft.create({
      // organizationId is not passed: the tenancy extension forces it from the request
      // context and overwrites anything supplied here (§1.3), so naming it would be a
      // second, ignorable source of truth. The cast is only to satisfy the generated
      // create input, which cannot know that.
      data: {
        dealerId: request.dealerId,
        sourceModule: request.sourceModule,
        // Deterministic substitution, after the model, from the DB values (§1.4).
        draftText: render(skeleton, request.variables),
        // Kept so "what exactly did we tell this dealer, and where did the number come
        // from" is answerable from the row alone.
        templateVariables: request.variables as unknown as Prisma.InputJsonValue,
        containsFinancialTerms: financial,
        requiresApproval: rule === null,
        autoSendRuleId: rule?.id ?? null,
      } as Prisma.MessageDraftUncheckedCreateInput,
    });
  }
}

/**
 * The adversarial boundary. A model that states its own number, alters a supplied one,
 * or invents an extra slot is rejected here — before anything is persisted, and long
 * before anything is sent.
 */
function assertModelBehaved(output: string, wanted: string[]): void {
  const text = output.trim();
  if (!text) throw new DraftingError('model returned nothing');

  // 1. No digit may survive from the model's own words. The placeholders are stripped
  //    first, so this is exactly "did the model write a number itself".
  assertNoDigits(text, 'model output');

  // 2. Every slot, the right number of times, and nothing invented. Catches a dropped
  //    amount, a duplicated one, and a hallucinated {{lateFee}} alike.
  const got = placeholdersIn(text);
  const tally = (names: string[]) =>
    names.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n]: (acc[n] ?? 0) + 1 }), {});
  const [a, b] = [tally(wanted), tally(got)];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) {
      throw new DraftingError(
        `model output uses {{${k}}} ${b[k] ?? 0} time(s), the template used it ${a[k] ?? 0} — ` +
          `refusing to render (§1.4, §10.5).`,
      );
    }
  }
}
