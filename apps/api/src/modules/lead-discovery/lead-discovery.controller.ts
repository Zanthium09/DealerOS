import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { DiscoveryService } from './discovery.service';

@Controller('lead-discovery')
@UseGuards(TenantAuthGuard)
export class LeadDiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  /** Paste a URL. Blocklisted domains come back REFUSED in the response itself. */
  @Post('runs/url')
  url(@CurrentTenantSession() session: TenantSession, @Body() body: { url?: string }) {
    if (!body?.url) throw new BadRequestException('url is required');
    return this.discovery.startUrl({ url: body.url, userId: session.userId });
  }

  /** Upload a file (base64 in JSON, same transport as the other importers). */
  @Post('runs/file')
  file(@CurrentTenantSession() session: TenantSession, @Body() body: { filename?: string; contentBase64?: string }) {
    if (!body?.filename || !body.contentBase64) throw new BadRequestException('filename and contentBase64 are required');
    return this.discovery.startFile({
      filename: body.filename,
      buffer: Buffer.from(body.contentBase64, 'base64'),
      userId: session.userId,
    });
  }

  /** Places crawl. Ends FAILED with an explicit reason until it is enabled (§16.8). */
  @Post('runs/places')
  places(@CurrentTenantSession() session: TenantSession, @Body() body: { city?: string; category?: string }) {
    return this.discovery.startProvider({
      method: 'PLACES_API',
      query: { city: body?.city ?? '', category: body?.category ?? '' },
      userId: session.userId,
    });
  }

  /** GST/MCA verification. Ends FAILED with an explicit reason until a vendor is chosen (§16.7). */
  @Post('runs/registry')
  registry(@CurrentTenantSession() session: TenantSession, @Body() body: { gstin?: string }) {
    return this.discovery.startProvider({ method: 'REGISTRY', query: { gstin: body?.gstin ?? '' }, userId: session.userId });
  }

  @Get('runs')
  runs() {
    return this.discovery.listRuns();
  }

  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.discovery.getRun(id);
  }

  @Get('candidates')
  candidates(@Query('status') status?: string, @Query('runId') runId?: string, @Query('take') take?: string) {
    return this.discovery.listCandidates({ status, runId, take: Number(take) || undefined });
  }

  @Post('candidates/:id/approve')
  approve(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.discovery.approve(id, session.userId);
  }

  @Post('candidates/:id/reject')
  async reject(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    await this.discovery.reject(id, session.userId);
    return { ok: true };
  }

  /** Batch decisions. Each is independent — one refusal (a duplicate) must not stop the rest. */
  @Post('candidates/decide')
  async decide(
    @CurrentTenantSession() session: TenantSession,
    @Body() body: { ids?: string[]; decision?: 'approve' | 'reject' },
  ) {
    if (!Array.isArray(body?.ids) || !['approve', 'reject'].includes(body?.decision ?? '')) {
      throw new BadRequestException('ids[] and decision (approve|reject) are required');
    }
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of body.ids.slice(0, 200)) {
      try {
        if (body.decision === 'approve') await this.discovery.approve(id, session.userId);
        else await this.discovery.reject(id, session.userId);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  /** §12.6 for discovery. */
  @Get('status')
  async status() {
    return { paused: await this.discovery.isPaused() };
  }

  @Post('pause')
  pause(@Body() body: { paused?: boolean }) {
    return this.discovery.setPaused(body?.paused !== false);
  }
}
