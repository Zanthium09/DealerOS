import { Inject, Injectable } from '@nestjs/common';
import { Dealer, MessageDraft, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { DraftingService, template, name } from '../../core/drafting';
import { SOURCE_MODULE } from './send.service';

/**
 * §5.2 — cold outreach draft. No financial terms by construction: the only variables
 * are names pulled straight from the database, so they use `name()` — not `text()`,
 * which is for model-adjacent prose and rejects digits real business names often
 * contain (e.g. "24x7 Traders"). This is a skeleton the model rewrites for tone
 * (drafting.service.ts's SYSTEM prompt), not an instruction — an instruction here
 * would be echoed verbatim by a model that doesn't distinguish "rewrite this" from
 * "here is what to write".
 *
 * This is the DEFAULT — used whenever an org has not saved its own wording via
 * OutreachTemplate (template.service.ts). An empty template table is a valid,
 * ordinary state, not a missing-config error.
 */
const DEFAULT_COLD_TEMPLATE = template(
  'Hello {{contactName}}, I am reaching out from {{ourBusinessName}} — we distribute ' +
    'to businesses like {{businessName}} and would love to explore working together as ' +
    'a dealer. If this sounds interesting, please reply and we can share more.',
);

@Injectable()
export class ColdDraftService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly drafting: DraftingService,
  ) {}

  async draft(
    dealer: Dealer & { contactPersonName?: string | null },
    ourBusinessName: string,
    templateId?: string,
  ): Promise<MessageDraft> {
    const active = templateId
      ? await this.prisma.outreachTemplate.findFirst({ where: { id: templateId } })
      : await this.prisma.outreachTemplate.findFirst({ where: { isActive: true } });
    if (templateId && !active) throw new Error(`no template ${templateId} in this organization`);

    const variables = personalisationFor(dealer, ourBusinessName);
    const subject = renderPlain(active?.subject?.trim() || DEFAULT_SUBJECT_TEMPLATE, variables);

    // A template with AI rewriting switched off is rendered here and never shown to
    // the model at all — which is precisely why it may contain literal digits (§1.4
    // constrains what the *model* writes). The AI path below is unchanged.
    if (active && !active.useAi) {
      return this.prisma.messageDraft.create({
        data: {
          dealerId: dealer.id,
          sourceModule: SOURCE_MODULE,
          subject,
          draftText: renderPlain(active.bodyText, variables),
          bodyHtml: active.bodyHtml ? renderPlain(active.bodyHtml, variables) : null,
          templateVariables: variables,
          containsFinancialTerms: false,
          // No model involved, so nothing to review for invention. Still routed by
          // the same auto-send rules as everything else via requiresApproval=false.
          requiresApproval: false,
          autoSendRuleId: 'verbatim-template',
        } as never,
      });
    }

    // Re-validated on load, not just on save (template.service.ts already does that):
    // defence in depth, cheap, and consistent with §1.4 being treated as structural
    // rather than a save-time-only courtesy.
    const skeleton = active ? template(active.bodyText) : DEFAULT_COLD_TEMPLATE;

    const draft = await this.drafting.draft({
      dealerId: dealer.id,
      sourceModule: SOURCE_MODULE,
      template: skeleton,
      variables: {
        businessName: name(dealer.businessName),
        contactName: name(dealer.contactPersonName ?? 'Sir/Madam'),
        ourBusinessName: name(ourBusinessName),
        ...(placeholderNeeded(skeleton, 'city') ? { city: name(dealer.city ?? 'your area') } : {}),
        ...(placeholderNeeded(skeleton, 'state') ? { state: name(dealer.state ?? '') } : {}),
        ...(placeholderNeeded(skeleton, 'region') ? { region: name(dealer.region ?? '') } : {}),
        ...(placeholderNeeded(skeleton, 'businessCategory')
          ? { businessCategory: name(dealer.businessCategory ?? 'your line of business') }
          : {}),
      },
    });

    // The subject is not model output — it is the org's own line with database
    // values substituted — so it is set after drafting rather than passed through it.
    return this.prisma.messageDraft.update({ where: { id: draft.id }, data: { subject } });
  }
}

/**
 * Keyed on the RECIPIENT's name, not ours, so the subject differs on every send.
 * A batch of cold emails sharing one byte-identical subject is the pattern bulk
 * filters look for — which is what the previous hardcoded "A note about your
 * business" was, on every message the app had ever sent.
 */
const DEFAULT_SUBJECT_TEMPLATE = 'Dealer partnership enquiry — {{businessName}}';

function placeholderNeeded(skeleton: string, key: string): boolean {
  return skeleton.includes(`{{${key}}}`);
}

function personalisationFor(
  dealer: Dealer & { contactPersonName?: string | null },
  ourBusinessName: string,
): Record<string, string> {
  return {
    businessName: dealer.businessName,
    contactName: dealer.contactPersonName ?? 'Sir/Madam',
    ourBusinessName,
    city: dealer.city ?? 'your area',
    state: dealer.state ?? '',
    region: dealer.region ?? '',
    businessCategory: dealer.businessCategory ?? 'your line of business',
  };
}

/** Deterministic {{placeholder}} substitution. No model, no invention — every value
 *  is a database column, which is exactly what §1.4 asks for. */
export function renderPlain(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => variables[key] ?? whole);
}

/** Has this dealer already got an outreach-email draft (pending, sent, or otherwise)?
 *  Cheap re-run guard for the orchestrator — a scheduler firing twice must not draft
 *  (and therefore email) the same NEW dealer twice. */
export async function alreadyDrafted(prisma: PrismaClient, dealerId: string): Promise<boolean> {
  const existing = await prisma.messageDraft.findFirst({
    where: { dealerId, sourceModule: SOURCE_MODULE },
  });
  return existing !== null;
}
