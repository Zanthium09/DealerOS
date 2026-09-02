import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantAuthGuard } from '../../core/auth';
import { TemplateService } from './template.service';
import type { TemplateInput } from './template.service';

@Controller('outreach-email/templates')
@UseGuards(TenantAuthGuard)
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Post()
  create(@Body() body: TemplateInput) {
    return this.templates.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<TemplateInput>) {
    return this.templates.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.templates.remove(id);
    return { ok: true };
  }

  @Post('reset-to-default')
  async resetToDefault() {
    await this.templates.resetToDefault();
    return { ok: true };
  }
}
