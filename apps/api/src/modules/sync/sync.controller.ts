import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { ImportKind, SyncService } from './sync.service';

const KINDS: ImportKind[] = ['orders', 'payments', 'products'];

@Controller('sync')
@UseGuards(TenantAuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * Starts a background import and returns at once — poll GET /sync/batches/:id.
   * The file arrives base64 in JSON, same transport as the contacts importer.
   */
  @Post('imports/:kind')
  start(
    @CurrentTenantSession() session: TenantSession,
    @Param('kind') kind: string,
    @Body() body: { filename?: string; contentBase64?: string; mapping?: Record<string, string> },
  ) {
    if (!KINDS.includes(kind as ImportKind)) throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
    if (!body?.filename || !body.contentBase64) throw new BadRequestException('filename and contentBase64 are required');
    return this.sync.start({
      kind: kind as ImportKind,
      filename: body.filename,
      buffer: Buffer.from(body.contentBase64, 'base64'),
      mapping: body.mapping,
      userId: session.userId,
    });
  }

  @Get('batches')
  batches() {
    return this.sync.listBatches();
  }

  @Get('batches/:id')
  async batch(@Param('id') id: string) {
    const b = await this.sync.getBatch(id);
    if (!b) throw new NotFoundException(`no sync batch ${id}`);
    return b;
  }

  /** §14 — when each kind of data was last synced. */
  @Get('freshness')
  freshness() {
    return this.sync.freshness();
  }

  @Post('recalculate-ageing')
  recalc() {
    return this.sync.recalculateAgeing();
  }

  @Get('scorecards')
  top(@Query('take') take?: string) {
    return this.sync.topDealers(Number(take) || 25);
  }

  @Get('scorecards/:dealerId')
  scorecard(@Param('dealerId') dealerId: string) {
    return this.sync.scorecard(dealerId);
  }
}
