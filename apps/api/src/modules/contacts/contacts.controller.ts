// Minimal HTTP surface (§17 — Phase 1 is a functional UI, not a polished one).
// The service layer is the thing that matters; this is a thin shell over it.
//
// The file arrives base64 in JSON rather than as multipart: no new dependency, and
// nothing about the import logic depends on the transport.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { isPlausibleEmail } from '../outreach-email/send.service';
import { PrismaClient } from '@prisma/client';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { ImportService } from './import.service';
import { MergeService } from './merge.service';
import type { ColumnMapping } from './normalize';

@Controller('contacts')
@UseGuards(TenantAuthGuard)
export class ContactsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly imports: ImportService,
    private readonly merges: MergeService,
  ) {}

  /** Upload → detected headers + suggested mapping. `source` is mandatory (§5.1). */
  @Post('imports')
  start(
    @CurrentTenantSession() session: TenantSession,
    @Body() body: { filename: string; contentBase64: string; source: string },
  ) {
    return this.imports.startBatch({
      filename: body.filename,
      buffer: Buffer.from(body.contentBase64 ?? '', 'base64'),
      source: body.source as never,
      createdByUserId: session.userId,
    });
  }

  /** Confirmed mapping + the same file → dealers, duplicates, review candidates. */
  @Post('imports/:id/run')
  run(
    @Param('id') id: string,
    @Body() body: { contentBase64: string; mapping: ColumnMapping },
  ) {
    return this.imports.runBatch(id, Buffer.from(body.contentBase64 ?? '', 'base64'), body.mapping);
  }

  /**
   * The dealer list: search, filter, sort, page. It was previously an unfiltered
   * "newest 200" dump, which is unusable once an org has thousands of dealers —
   * there was no way to find a specific company at all.
   *
   * `search` matches business name, contact person, city and email address. Case
   * insensitive, substring — Postgres ILIKE via Prisma's `contains`/`mode`.
   */
  @Get()
  async list(
    @Query('pipelineStage') pipelineStage?: string,
    @Query('search') search?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
    @Query('businessCategory') businessCategory?: string,
    @Query('source') source?: string,
    @Query('hasEmail') hasEmail?: string,
    @Query('sort') sort?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const term = search?.trim();
    const where = {
      ...(pipelineStage ? { pipelineStage: pipelineStage as never } : {}),
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(businessCategory ? { businessCategory } : {}),
      ...(source ? { source: source as never } : {}),
      ...(hasEmail === 'true' ? { emails: { some: {} } } : {}),
      ...(hasEmail === 'false' ? { emails: { none: {} } } : {}),
      ...(term
        ? {
            OR: [
              { businessName: { contains: term, mode: 'insensitive' as const } },
              { contactPersonName: { contains: term, mode: 'insensitive' as const } },
              { city: { contains: term, mode: 'insensitive' as const } },
              { emails: { some: { address: { contains: term.toLowerCase() } } } },
            ],
          }
        : {}),
    };

    return this.prisma.dealer.findMany({
      where,
      orderBy: ORDER_BY[sort ?? 'newest'] ?? ORDER_BY.newest,
      take: Math.min(Number(take) || 200, 500),
      skip: Number(skip) || 0,
      include: { emails: { where: { isPrimary: true }, take: 1 } },
    });
  }

  /** Total matching the same filters, so the UI can page and show a real count. */
  @Get('count')
  count(@Query('pipelineStage') pipelineStage?: string, @Query('search') search?: string) {
    const term = search?.trim();
    return this.prisma.dealer
      .count({
        where: {
          ...(pipelineStage ? { pipelineStage: pipelineStage as never } : {}),
          ...(term
            ? {
                OR: [
                  { businessName: { contains: term, mode: 'insensitive' as const } },
                  { contactPersonName: { contains: term, mode: 'insensitive' as const } },
                  { city: { contains: term, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
      })
      .then((total) => ({ total }));
  }

  /** The review queue — fuzzy matches waiting for a human (§5.1, §10.1).
   *  Declared before ':id' — Nest matches literal path segments in registration
   *  order, and 'duplicates' would otherwise be swallowed as a dealer id. */
  @Get('duplicates')
  duplicates(@Query('status') status?: string) {
    return this.prisma.duplicateCandidate.findMany({
      where: { status: (status as never) ?? 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const dealer = await this.prisma.dealer.findFirst({
      where: { id },
      include: {
        emails: true,
        phones: true,
        consentLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
        interactionEvents: { orderBy: { createdAt: 'desc' }, take: 50 },
        assignedSalesman: { select: { id: true, name: true, email: true } },
      },
    });
    if (!dealer) throw new NotFoundException(`no dealer ${id}`);
    return dealer;
  }

  /** Manual overrides a rep needs day to day: a note, moving the pipeline stage by
   *  hand (not every transition is driven by an inbound reply), reassigning who owns
   *  the relationship. Every field optional — send only what changed. */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { notes?: string | null; pipelineStage?: string; assignedSalesmanId?: string | null },
  ) {
    const dealer = await this.prisma.dealer.findFirst({ where: { id } });
    if (!dealer) throw new NotFoundException(`no dealer ${id}`);
    return this.prisma.dealer.update({
      where: { id },
      data: {
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.pipelineStage !== undefined ? { pipelineStage: body.pipelineStage as never } : {}),
        ...(body.assignedSalesmanId !== undefined ? { assignedSalesmanId: body.assignedSalesmanId } : {}),
      },
    });
  }

  /**
   * Email management for one dealer. There was no way to correct an address at all,
   * which mattered because messy imports produce unusable ones — a real dealer's
   * primary address was the literal string "microdots", a fragment of a free-text
   * cell, and nothing could reach them until it was fixed.
   */
  @Post(':id/emails')
  async addEmail(@Param('id') id: string, @Body() body: { address?: unknown; isPrimary?: unknown }) {
    const address = String(body?.address ?? '').trim().toLowerCase();
    if (!isPlausibleEmail(address)) throw new BadRequestException(`"${address}" is not a valid email address`);
    const dealer = await this.prisma.dealer.findFirst({ where: { id } });
    if (!dealer) throw new NotFoundException(`no dealer ${id}`);

    const makePrimary = body?.isPrimary === true;
    if (makePrimary) {
      await this.prisma.dealerEmail.updateMany({ where: { dealerId: id }, data: { isPrimary: false } });
    }
    return this.prisma.dealerEmail.create({
      data: {
        organizationId: dealer.organizationId,
        dealerId: id,
        address,
        isPrimary: makePrimary || (await this.prisma.dealerEmail.count({ where: { dealerId: id } })) === 0,
      },
    });
  }

  @Patch(':id/emails/:emailId')
  async updateEmail(
    @Param('id') id: string,
    @Param('emailId') emailId: string,
    @Body() body: { address?: unknown; isPrimary?: unknown; verificationStatus?: unknown },
  ) {
    const existing = await this.prisma.dealerEmail.findFirst({ where: { id: emailId, dealerId: id } });
    if (!existing) throw new NotFoundException(`no email ${emailId} on dealer ${id}`);

    let address: string | undefined;
    if (body?.address !== undefined) {
      address = String(body.address).trim().toLowerCase();
      if (!isPlausibleEmail(address)) throw new BadRequestException(`"${address}" is not a valid email address`);
    }
    if (body?.isPrimary === true) {
      await this.prisma.dealerEmail.updateMany({ where: { dealerId: id }, data: { isPrimary: false } });
    }
    return this.prisma.dealerEmail.update({
      where: { id: emailId },
      data: {
        ...(address !== undefined ? { address, verificationStatus: 'UNVERIFIED' as const } : {}),
        ...(body?.isPrimary !== undefined ? { isPrimary: body.isPrimary === true } : {}),
        ...(typeof body?.verificationStatus === 'string'
          ? { verificationStatus: body.verificationStatus as never }
          : {}),
      },
    });
  }

  @Delete(':id/emails/:emailId')
  async removeEmail(@Param('id') id: string, @Param('emailId') emailId: string) {
    const existing = await this.prisma.dealerEmail.findFirst({ where: { id: emailId, dealerId: id } });
    if (!existing) throw new NotFoundException(`no email ${emailId} on dealer ${id}`);
    await this.prisma.dealerEmail.delete({ where: { id: emailId } });
    // Never leave a dealer with addresses but no primary — the send path picks the
    // primary first and would otherwise fall back arbitrarily.
    if (existing.isPrimary) {
      const next = await this.prisma.dealerEmail.findFirst({ where: { dealerId: id } });
      if (next) await this.prisma.dealerEmail.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    return { ok: true };
  }

  @Post('merges')
  merge(
    @CurrentTenantSession() session: TenantSession,
    @Body() body: { survivingDealerId: string; mergedDealerId: string; candidateId?: string },
  ) {
    return this.merges.merge({ ...body, userId: session.userId });
  }

  @Post('merges/:id/reverse')
  async reverse(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    await this.merges.reverse(id, session.userId);
    return { reversed: true };
  }
}

/** Named sorts, so a client cannot pass an arbitrary Prisma orderBy through. */
const ORDER_BY: Record<string, object> = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  name: { businessName: 'asc' },
  nameDesc: { businessName: 'desc' },
  city: { city: 'asc' },
  stage: { pipelineStage: 'asc' },
};
