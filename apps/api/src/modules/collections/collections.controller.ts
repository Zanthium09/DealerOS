import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { ApprovalService } from '../../core/approval';
import { COLLECTIONS_SOURCE_MODULE, CollectionsService, SettingsInput } from './collections.service';

@Controller('collections')
@UseGuards(TenantAuthGuard)
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly approval: ApprovalService,
  ) {}

  @Get('overview')
  overview() {
    return this.collections.overview();
  }

  @Patch('settings')
  update(@Body() body: SettingsInput) {
    return this.collections.updateSettings(body ?? {});
  }

  /** `dryRun: true` reports who would be reminded or flagged and writes nothing. */
  @Post('run')
  run(@Body() body: { dryRun?: boolean } = {}) {
    return this.collections.run({ dryRun: body?.dryRun === true });
  }

  @Get('queue')
  queue() {
    return this.approval.pending({ sourceModule: COLLECTIONS_SOURCE_MODULE });
  }

  // Goes through the service, not approval directly: it re-checks freshness and the
  // stated balance before anything is sent (§10.4).
  @Post('drafts/:id/approve')
  approve(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.collections.approveAndSend(id, session.userId);
  }

  @Post('drafts/:id/reject')
  reject(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.approval.reject(id, session.userId);
  }

  @Post('dealers/:dealerId/acknowledge')
  async acknowledge(@Param('dealerId') dealerId: string) {
    await this.collections.acknowledge(dealerId);
    return { ok: true };
  }
}
