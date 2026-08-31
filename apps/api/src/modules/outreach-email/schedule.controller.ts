import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { ScheduleInput, ScheduleService } from './schedule.service';

/**
 * "Every possible way of sending" — the recurring half. See schedule.service.ts:
 * a schedule is only ever a stored instruction for WHEN to call the same
 * OutreachEmailService.runColdOutreach the manual dashboard button calls.
 */
@Controller('outreach-email/schedules')
@UseGuards(TenantAuthGuard)
export class ScheduleController {
  constructor(private readonly schedules: ScheduleService) {}

  @Get()
  list() {
    return this.schedules.list();
  }

  @Post()
  create(@CurrentTenantSession() session: TenantSession, @Body() body: ScheduleInput) {
    return this.schedules.create(session.userId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<ScheduleInput>) {
    return this.schedules.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.schedules.remove(id);
    return { ok: true };
  }
}
