import { Inject, Injectable } from '@nestjs/common';
import { Dealer, MessageDraft, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { DraftingService, template, text } from '../../core/drafting';
import { SOURCE_MODULE } from './send.service';

/**
 * §5.2 — cold outreach draft. No financial terms by construction: the only variables
 * are names, both `text()` (§1.4's prose slot, which refuses digits itself). This is
 * a skeleton the model rewrites for tone (drafting.service.ts's SYSTEM prompt), not
 * an instruction — an instruction here would be echoed verbatim by a model that
 * doesn't distinguish "rewrite this" from "here is what to write".
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
  ): Promise<MessageDraft> {
    const active = await this.prisma.outreachTemplate.findFirst({ where: { isActive: true } });
    // Re-validated on load, not just on save (template.service.ts already does that):
    // defence in depth, cheap, and consistent with §1.4 being treated as structural
    // rather than a save-time-only courtesy.
    const skeleton = active ? template(active.bodyText) : DEFAULT_COLD_TEMPLATE;

    return this.drafting.draft({
      dealerId: dealer.id,
      sourceModule: SOURCE_MODULE,
      template: skeleton,
      variables: {
        businessName: text(dealer.businessName),
        contactName: text(dealer.contactPersonName ?? 'Sir/Madam'),
        ourBusinessName: text(ourBusinessName),
      },
    });
  }
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
