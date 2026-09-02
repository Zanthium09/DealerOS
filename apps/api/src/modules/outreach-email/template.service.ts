import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OutreachTemplate, PrismaClient } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { DraftingError, placeholdersIn, template } from '../../core/drafting';

/**
 * Exactly what cold-draft.service.ts's DEFAULT_COLD_TEMPLATE offers today: contact
 * name, own business name, dealer's business name. Not "any variable the drafting
 * service happens to support" — money()/quantity()/percent() are financial-term
 * kinds and cold outreach must never carry one by construction (§5.2's whole "no
 * financial terms" premise). A saved template that used {{amountDue}} would compile
 * fine here and then throw "no variable for placeholder" deep inside a send — this
 * validates it at SAVE time instead, with a message that actually explains why.
 */
const ALLOWED_PLACEHOLDERS = new Set([
  'contactName',
  'ourBusinessName',
  'businessName',
  // Dealer columns are safe to expose: they are verbatim database strings rendered
  // by name(), never anything the model computes (§1.4). Personalising on city and
  // category is the difference between a mail that reads as addressed to someone
  // and one that reads as a blast.
  'city',
  'state',
  'region',
  'businessCategory',
]);

@Injectable()
export class TemplateService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  list(): Promise<OutreachTemplate[]> {
    return this.prisma.outreachTemplate.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(input: TemplateInput): Promise<OutreachTemplate> {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    const useAi = input.useAi ?? true;
    const bodyText = this.validate(input.bodyText, useAi);
    const subject = this.validateSubject(input.subject, useAi);

    const willBeActive = input.isActive ?? true;
    return this.prisma.$transaction(async (tx) => {
      // Exactly one active template per org — enforced here, not by a unique index,
      // since "make this one active" legitimately means "and deactivate whichever
      // one was".
      if (willBeActive) await tx.outreachTemplate.updateMany({ data: { isActive: false } });
      return tx.outreachTemplate.create({
        data: {
          organizationId: getOrgId()!,
          name: input.name.trim(),
          subject,
          bodyText,
          bodyHtml: input.bodyHtml ?? null,
          useAi,
          isActive: willBeActive,
        },
      });
    });
  }

  async update(id: string, input: Partial<TemplateInput>): Promise<OutreachTemplate> {
    const existing = await this.load(id);
    const useAi = input.useAi ?? existing.useAi;
    const bodyText = input.bodyText !== undefined ? this.validate(input.bodyText, useAi) : undefined;
    const subject = input.subject !== undefined ? this.validateSubject(input.subject, useAi) : undefined;

    return this.prisma.$transaction(async (tx) => {
      if (input.isActive === true) await tx.outreachTemplate.updateMany({ data: { isActive: false } });
      return tx.outreachTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(subject !== undefined ? { subject } : {}),
          ...(bodyText !== undefined ? { bodyText } : {}),
          ...(input.bodyHtml !== undefined ? { bodyHtml: input.bodyHtml } : {}),
          ...(input.useAi !== undefined ? { useAi: input.useAi } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
    });
  }

  async remove(id: string): Promise<void> {
    await this.load(id);
    await this.prisma.outreachTemplate.delete({ where: { id } });
  }

  /** Reverts to the hardcoded default (cold-draft.service.ts) by deactivating every
   *  saved template — an empty/all-inactive table is what makes that fallback fire. */
  async resetToDefault(): Promise<void> {
    await this.prisma.outreachTemplate.updateMany({ data: { isActive: false } });
  }

  private async load(id: string): Promise<OutreachTemplate> {
    const row = await this.prisma.outreachTemplate.findFirst({ where: { id } });
    if (!row) throw new BadRequestException(`no template ${id} in this organization`);
    return row;
  }

  private validateSubject(subject: string | undefined, useAi: boolean): string {
    const value = (subject ?? '').trim();
    if (!value) return '';
    if (value.length > 200) throw new BadRequestException('subject is too long (max 200 characters)');
    return this.checkPlaceholders(value, useAi);
  }

  private validate(bodyText: string, useAi: boolean): string {
    if (!bodyText?.trim()) throw new BadRequestException('bodyText is required');
    return this.checkPlaceholders(bodyText, useAi);
  }

  /**
   * The digit ban is a property of the AI path, not of templates. §1.4's rule is
   * that the *model* never produces a number — so when `useAi` is false the text is
   * rendered deterministically, the model never sees it, and a human-typed "24x7"
   * or "Since 1995" is simply their own copy. Applying the ban there was blocking
   * legitimate wording for no safety gain.
   */
  private checkPlaceholders(bodyText: string, useAi: boolean): string {
    let skeleton: string;
    if (useAi) {
      try {
        skeleton = template(bodyText); // §1.4 — throws on any digit outside a placeholder
      } catch (err) {
        throw new BadRequestException(
          (err instanceof DraftingError ? err.message : String(err)) +
            ' — or switch this template off AI rewriting, which allows literal numbers.',
        );
      }
    } else {
      skeleton = bodyText;
    }
    const unknown = placeholdersIn(skeleton).filter((name) => !ALLOWED_PLACEHOLDERS.has(name));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `unknown placeholder(s) {{${unknown.join('}}, {{')}}} — this template may only use ` +
          `{{${[...ALLOWED_PLACEHOLDERS].join('}}, {{')}}}`,
      );
    }
    return skeleton;
  }
}

export type TemplateInput = {
  name: string;
  subject?: string;
  bodyText: string;
  bodyHtml?: string | null;
  useAi?: boolean;
  isActive?: boolean;
};
