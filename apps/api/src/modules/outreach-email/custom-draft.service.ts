import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { MessageDraft, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { AI_PROVIDER, AIProvider } from '../../providers/ai/ai.provider';
import { DraftingError, assertNoDigits } from '../../core/drafting';
import { SOURCE_MODULE } from './send.service';

/**
 * "Give the AI free-text context and let it write the email" — the feature this
 * exists for — is a genuinely different shape of request from cold-draft.service.ts:
 * no template, no typed variables, no fixed placeholder set. It cannot reuse
 * DraftingService.draft() (that method's whole contract is placeholder-in,
 * typed-value-out) so this is a deliberate SIBLING path, not a modification of it.
 *
 * The safety property still holds, just enforced differently:
 *   - The staff member's brief is never sent to a dealer — it is instructions TO the
 *     model, so it may contain numbers freely ("mention our 20% off this month" is a
 *     legitimate brief). Nothing in the brief is restricted.
 *   - What the model WRITES BACK is the thing that could reach a dealer, so THAT is
 *     checked with the exact same assertNoDigits() every other path in this app uses
 *     (§1.4). A single digit anywhere in the model's output rejects the whole draft —
 *     no silent stripping, no partial acceptance. The caller rephrases the brief
 *     (ask for the offer without a figure) or adds the real number by hand after a
 *     clean draft exists, during the ordinary edit-and-approve step (§1.5 — a human
 *     typing a number is the system working as designed).
 *   - Every custom draft requires approval, unconditionally, regardless of whether a
 *     financial term is detectable. containsFinancialTerms only catches an explicit
 *     digit; free-form AI prose can still make a claim a template could never make,
 *     so this path never gets the auto-send exemption the templated cold-outreach
 *     path can (§9).
 */
@Injectable()
export class CustomDraftService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
  ) {}

  async draft(dealerId: string, brief: string): Promise<MessageDraft> {
    if (!brief?.trim()) throw new BadRequestException('brief is required');

    const dealer = await this.prisma.dealer.findFirst({ where: { id: dealerId } });
    if (!dealer) throw new BadRequestException(`no dealer ${dealerId} in this organization`);
    const org = await this.prisma.organization.findFirst({ where: { id: getOrgId()! } });
    if (!org) throw new BadRequestException('organization not found');

    const system = [
      `You write a short, plain business email from "${org.name}", a distribution`,
      'company, addressed to one of its dealers, based on instructions from a staff',
      'member.',
      '',
      `The dealer's real business name is "${dealer.businessName}"` +
        (dealer.contactPersonName ? ` and the contact person is "${dealer.contactPersonName}".` : '.'),
      '',
      'Absolute rules:',
      '- Never write a digit or any other numeral, in any script. Not a figure, not a',
      '  date, not an amount, not a count, not a fraction, not a Roman numeral, and not',
      '  a number spelled out in words either.',
      '- If the instructions ask you to state a specific number (a price, a discount,',
      '  a quantity, a date), leave it out entirely rather than guessing or writing a',
      '  placeholder word for it — do not write "[amount]" or similar either.',
      '- Plain text only. No bidi, zero-width or other invisible control characters.',
      '- Output the email only. No preamble, no explanation, no subject line, no',
      '  quotes around it.',
    ].join('\n');

    const draftText = await this.ai.complete({
      system,
      prompt: `Instructions from staff:\n${brief.trim()}`,
    });

    try {
      assertNoDigits(draftText, 'the drafted email');
    } catch (err) {
      throw new BadRequestException(
        (err instanceof DraftingError ? err.message : String(err)) +
          ' Rephrase the instructions to describe the offer without stating a figure — ' +
          'you can add the real number yourself after a clean draft exists, during review.',
      );
    }
    if (!draftText.trim()) throw new BadRequestException('the model returned an empty draft');

    return this.prisma.messageDraft.create({
      data: {
        organizationId: getOrgId()!,
        dealerId,
        sourceModule: SOURCE_MODULE,
        draftText: draftText.trim(),
        templateVariables: { brief: brief.trim(), custom: true },
        containsFinancialTerms: false,
        // Unconditional — see the class doc. This path never qualifies for auto-send.
        requiresApproval: true,
      },
    });
  }
}
