import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, WhatsAppTemplate } from '@prisma/client';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';
import { WHATSAPP_PROVIDER, WhatsAppProvider } from '../../providers/whatsapp';
import { validateTemplate } from './rules';

export type TemplateInput = {
  name: string;
  language?: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  bodyText: string;
  paramKeys?: string[];
};

// Meta requires a sample value for every {{n}}; these are what a reviewer sees.
const EXAMPLES: Record<string, string> = {
  contactName: 'Rajesh',
  businessName: 'Sharma Traders',
  city: 'Pune',
  state: 'Maharashtra',
};

/**
 * §5.3 — "the template library is the content, not a suggestion". Free-form marketing
 * outside the 24h window is not permitted, so what a dealer can be sent is exactly what
 * is on this list AND approved by Meta. Nothing here is model-written.
 */
@Injectable()
export class WhatsAppTemplateService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
  ) {}

  list(): Promise<WhatsAppTemplate[]> {
    return this.prisma.whatsAppTemplate.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(input: TemplateInput): Promise<WhatsAppTemplate> {
    const paramKeys = input.paramKeys ?? [];
    const problem = validateTemplate({ name: input.name, bodyText: input.bodyText, paramKeys });
    if (problem) throw new BadRequestException(problem);
    try {
      return await this.prisma.whatsAppTemplate.create({
        data: {
          organizationId: getOrgId()!,
          name: input.name,
          language: input.language ?? 'en',
          category: input.category,
          bodyText: input.bodyText,
          paramKeys,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new BadRequestException(`a template named "${input.name}" (${input.language ?? 'en'}) already exists`);
      throw err;
    }
  }

  /** DRAFT/REJECTED → PENDING. Editing an approved template is not offered: Meta versions
   *  approved wording, so a change is a new template, not an edit. */
  async submit(id: string): Promise<WhatsAppTemplate> {
    const t = await this.load(id);
    if (t.status !== 'DRAFT' && t.status !== 'REJECTED') {
      throw new BadRequestException(`template is ${t.status} — only a DRAFT or REJECTED one can be (re)submitted`);
    }
    const org = await this.prisma.organization.findFirst({ select: { name: true } });
    const examples = t.paramKeys.map((k) => (k === 'ourBusinessName' ? (org?.name ?? 'Our Company') : (EXAMPLES[k] ?? 'Example')));
    const out = await this.whatsapp.submitTemplate({
      name: t.name,
      language: t.language,
      category: t.category,
      bodyText: t.bodyText,
      examples,
    });
    return this.prisma.whatsAppTemplate.update({
      where: { id },
      data: { status: out.status, metaTemplateId: out.metaTemplateId, rejectionReason: null },
    });
  }

  /** Pull the current status from Meta — for when the webhook was missed. */
  async sync(id: string): Promise<WhatsAppTemplate> {
    const t = await this.load(id);
    if (!t.metaTemplateId) throw new BadRequestException('this template has not been submitted to Meta yet');
    const s = await this.whatsapp.getTemplateStatus(t.metaTemplateId);
    return this.prisma.whatsAppTemplate.update({
      where: { id },
      data: { status: s.status, rejectionReason: s.rejectionReason ?? null },
    });
  }

  async remove(id: string): Promise<void> {
    const t = await this.load(id);
    if (t.status !== 'DRAFT' && t.status !== 'REJECTED') {
      throw new BadRequestException('only a DRAFT or REJECTED template can be deleted here — an approved one lives on Meta’s side');
    }
    await this.prisma.whatsAppTemplate.delete({ where: { id } });
  }

  async load(id: string): Promise<WhatsAppTemplate> {
    const t = await this.prisma.whatsAppTemplate.findFirst({ where: { id } });
    if (!t) throw new NotFoundException(`no WhatsApp template ${id}`);
    return t;
  }
}
