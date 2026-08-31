// Minimal HTTP surface (§17 — Phase 1 is a functional UI, not a polished one).
// The service layer is the thing that matters; this is a thin shell over it.
//
// The file arrives base64 in JSON rather than as multipart: no new dependency, and
// nothing about the import logic depends on the transport.
import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
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

  /** Dashboard's dealer list, optionally filtered by pipeline stage. */
  @Get()
  list(@Query('pipelineStage') pipelineStage?: string) {
    return this.prisma.dealer.findMany({
      where: pipelineStage ? { pipelineStage: pipelineStage as never } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { emails: { where: { isPrimary: true }, take: 1 } },
    });
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
