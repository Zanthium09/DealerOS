import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CallOutcome } from '@prisma/client';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { BriefService } from './brief.service';
import { CallService } from './call.service';

@Controller('calling')
@UseGuards(TenantAuthGuard)
export class CallingController {
  constructor(
    private readonly calls: CallService,
    private readonly briefs: BriefService,
  ) {}

  /** Who to call next. */
  @Get('queue')
  queue() {
    return this.calls.queue();
  }

  @Get('brief/:dealerId')
  brief(@Param('dealerId') dealerId: string) {
    return this.briefs.brief(dealerId);
  }

  @Post('log')
  log(
    @CurrentTenantSession() session: TenantSession,
    @Body()
    body: { dealerId?: string; outcome?: string; notes?: string; durationSeconds?: number; followUpAt?: string },
  ) {
    if (!body?.dealerId) throw new BadRequestException('dealerId is required');
    if (!body.outcome || !Object.values(CallOutcome).includes(body.outcome as CallOutcome)) {
      throw new BadRequestException(`outcome must be one of ${Object.values(CallOutcome).join(', ')}`);
    }
    return this.calls.log({
      dealerId: body.dealerId,
      outcome: body.outcome as CallOutcome,
      notes: body.notes,
      durationSeconds: body.durationSeconds,
      followUpAt: body.followUpAt,
      userId: session.userId,
    });
  }

  @Get('history/:dealerId')
  history(@Param('dealerId') dealerId: string) {
    return this.calls.history(dealerId);
  }

  @Get('follow-ups')
  followUps() {
    return this.calls.followUps();
  }

  @Post('follow-ups/:id/done')
  async done(@Param('id') id: string) {
    await this.calls.completeFollowUp(id);
    return { ok: true };
  }
}
