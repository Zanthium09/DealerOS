import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { ApprovalError, ApprovalService } from '../../core/approval';
import { EmailSendService } from '../outreach-email/send.service';
import { DORMANCY_SOURCE_MODULE, DormancyService, SettingsInput } from './dormancy.service';

@Controller('dormancy')
@UseGuards(TenantAuthGuard)
export class DormancyController {
  constructor(
    private readonly dormancy: DormancyService,
    private readonly approval: ApprovalService,
    private readonly email: EmailSendService,
  ) {}

  @Get('overview')
  overview() {
    return this.dormancy.overview();
  }

  @Patch('settings')
  update(@Body() body: SettingsInput) {
    return this.dormancy.updateSettings(body ?? {});
  }

  /** Run the scan now. `dryRun: true` reports what it would do and writes nothing — the
   *  way to see who would be marked dormant before switching the module on. */
  @Post('scan')
  scan(@Body() body: { dryRun?: boolean } = {}) {
    return this.dormancy.scan({ dryRun: body?.dryRun === true });
  }

  @Get('queue')
  queue() {
    return this.approval.pending({ sourceModule: DORMANCY_SOURCE_MODULE });
  }

  @Post('drafts/:id/approve')
  async approve(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    const draft = await this.approval.approve(id, session.userId);
    try {
      const event = await this.email.sendApprovedDraft(draft.id);
      return { sent: true, interactionEventId: event.id };
    } catch (err) {
      if (err instanceof ApprovalError) throw err;
      // The decision stands and is audited; the draft stays APPROVED with the reason.
      throw new BadRequestException(`${err instanceof Error ? err.message : String(err)} — the draft stays approved and can be retried.`);
    }
  }

  @Post('drafts/:id/reject')
  reject(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.approval.reject(id, session.userId);
  }
}
