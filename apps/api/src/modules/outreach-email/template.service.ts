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
const ALLOWED_PLACEHOLDERS = new Set(['contactName', 'ourBusinessName', 'businessName']);

@Injectable()
export class TemplateService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  list(): Promise<OutreachTemplate[]> {
    return this.prisma.outreachTemplate.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(input: { name: string; bodyText: string; isActive?: boolean }): Promise<OutreachTemplate> {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    const bodyText = this.validate(input.bodyText);

    const willBeActive = input.isActive ?? true;
    return this.prisma.$transaction(async (tx) => {
      // Exactly one active template per org — enforced here, not by a unique index,
      // since "make this one active" legitimately means "and deactivate whichever
      // one was".
      if (willBeActive) await tx.outreachTemplate.updateMany({ data: { isActive: false } });
      return tx.outreachTemplate.create({
        data: { organizationId: getOrgId()!, name: input.name.trim(), bodyText, isActive: willBeActive },
      });
    });
  }

  async update(id: string, input: { name?: string; bodyText?: string; isActive?: boolean }): Promise<OutreachTemplate> {
    await this.load(id);
    const bodyText = input.bodyText !== undefined ? this.validate(input.bodyText) : undefined;

    return this.prisma.$transaction(async (tx) => {
      if (input.isActive === true) await tx.outreachTemplate.updateMany({ data: { isActive: false } });
      return tx.outreachTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(bodyText !== undefined ? { bodyText } : {}),
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

  private validate(bodyText: string): string {
    if (!bodyText?.trim()) throw new BadRequestException('bodyText is required');
    let skeleton: string;
    try {
      skeleton = template(bodyText); // §1.4 — throws on any digit outside a placeholder
    } catch (err) {
      throw new BadRequestException(err instanceof DraftingError ? err.message : String(err));
    }
    const unknown = placeholdersIn(skeleton).filter((name) => !ALLOWED_PLACEHOLDERS.has(name));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `unknown placeholder(s) {{${unknown.join('}}, {{')}}} — this template may only use ` +
          `{{contactName}}, {{ourBusinessName}}, {{businessName}}`,
      );
    }
    return skeleton;
  }
}
