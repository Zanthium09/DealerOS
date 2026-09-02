import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantAuthGuard } from '../../core/auth';
import { CampaignService } from './campaign.service';
import type { CampaignInput } from './campaign.service';

@Controller('outreach-email/campaigns')
@UseGuards(TenantAuthGuard)
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  @Post()
  create(@Body() body: CampaignInput) {
    return this.campaigns.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<CampaignInput> & { status?: string }) {
    return this.campaigns.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.campaigns.remove(id);
    return { ok: true };
  }

  /** Who this would reach — shown before anyone commits to a send. */
  @Get(':id/preview')
  preview(@Param('id') id: string) {
    return this.campaigns.preview(id);
  }

  @Get(':id/stats')
  stats(@Param('id') id: string) {
    return this.campaigns.stats(id);
  }

  @Post(':id/run')
  run(
    @Param('id') id: string,
    @Body() body: { maxDealers?: number; forceReview?: boolean; allowResend?: boolean } = {},
  ) {
    return this.campaigns.run(id, {
      maxDealers: typeof body.maxDealers === 'number' && body.maxDealers > 0 ? body.maxDealers : undefined,
      forceReview: body.forceReview === true,
      allowResend: body.allowResend === true,
    });
  }
}
