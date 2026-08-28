import { Injectable } from '@nestjs/common';
import { Dealer, MessageDraft, PrismaClient } from '@prisma/client';
import { DraftingService, template, text } from '../../core/drafting';
import { SOURCE_MODULE } from './send.service';

/**
 * §5.2 — cold outreach draft. No financial terms by construction: the only variables
 * are names, both `text()` (§1.4's prose slot, which refuses digits itself). This is
 * a skeleton the model rewrites for tone (drafting.service.ts's SYSTEM prompt), not
 * an instruction — an instruction here would be echoed verbatim by a model that
 * doesn't distinguish "rewrite this" from "here is what to write".
 */
const COLD_TEMPLATE = template(
  'Hello {{contactName}}, I am reaching out from {{ourBusinessName}} — we distribute ' +
    'to businesses like {{businessName}} and would love to explore working together as ' +
    'a dealer. If this sounds interesting, please reply and we can share more.',
);

@Injectable()
export class ColdDraftService {
  constructor(private readonly drafting: DraftingService) {}

  draft(
    dealer: Dealer & { contactPersonName?: string | null },
    ourBusinessName: string,
  ): Promise<MessageDraft> {
    return this.drafting.draft({
      dealerId: dealer.id,
      sourceModule: SOURCE_MODULE,
      template: COLD_TEMPLATE,
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
