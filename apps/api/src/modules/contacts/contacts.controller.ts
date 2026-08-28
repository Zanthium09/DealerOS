// Minimal HTTP surface (§17 — Phase 1 is a functional UI, not a polished one).
// The service layer is the thing that matters; this is a thin shell over it.
//
// The file arrives base64 in JSON rather than as multipart: no new dependency, and
// nothing about the import logic depends on the transport.
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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

  /** The review queue — fuzzy matches waiting for a human (§5.1, §10.1). */
  @Get('duplicates')
  duplicates(@Query('status') status?: string) {
    return this.prisma.duplicateCandidate.findMany({
      where: { status: (status as never) ?? 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 100,
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
