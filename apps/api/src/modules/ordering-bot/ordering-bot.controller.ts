import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantAuthGuard } from '../../core/auth';
import { BotSettingsInput, OrderingBotService } from './ordering-bot.service';

@Controller('ordering-bot')
@UseGuards(TenantAuthGuard)
export class OrderingBotController {
  constructor(private readonly bot: OrderingBotService) {}

  @Get('overview')
  overview() {
    return this.bot.overview();
  }

  @Patch('settings')
  update(@Body() body: BotSettingsInput) {
    return this.bot.updateSettings(body ?? {});
  }

  @Post('pilot/:dealerId')
  async enroll(@Param('dealerId') dealerId: string) {
    await this.bot.enroll(dealerId);
    return { ok: true };
  }

  @Delete('pilot/:dealerId')
  async unenroll(@Param('dealerId') dealerId: string) {
    await this.bot.unenroll(dealerId);
    return { ok: true };
  }
}
