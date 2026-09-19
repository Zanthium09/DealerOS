import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentTenantSession, TenantAuthGuard } from '../../core/auth';
import type { TenantSession } from '../../core/auth';
import { ApprovalService } from '../../core/approval';
import { SCHEMES_SOURCE_MODULE, SchemeInput, SchemesService } from './schemes.service';

@Controller('schemes')
@UseGuards(TenantAuthGuard)
export class SchemesController {
  constructor(
    private readonly schemes: SchemesService,
    private readonly approval: ApprovalService,
  ) {}

  @Get()
  list() {
    return this.schemes.list();
  }

  @Get('products')
  products() {
    return this.schemes.products();
  }

  @Post()
  create(@Body() body: SchemeInput) {
    return this.schemes.create(body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: SchemeInput) {
    return this.schemes.update(id, body ?? {});
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.schemes.remove(id);
    return { ok: true };
  }

  @Get(':id/preview')
  preview(@Param('id') id: string) {
    return this.schemes.preview(id);
  }

  @Post(':id/activate')
  activate(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.schemes.activate(id, session.userId);
  }

  @Post(':id/end')
  async end(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    await this.schemes.end(id, session.userId);
    return { ok: true };
  }

  /** `dryRun: true` counts who would be drafted for and writes nothing. */
  @Post(':id/broadcast')
  broadcast(@Param('id') id: string, @Body() body: { dryRun?: boolean } = {}) {
    return this.schemes.broadcast(id, { dryRun: body?.dryRun === true });
  }

  @Post('attribute')
  attribute() {
    return this.schemes.attribute();
  }

  @Get('queue/pending')
  queue() {
    return this.approval.pending({ sourceModule: SCHEMES_SOURCE_MODULE });
  }

  @Post('drafts/:id/approve')
  approve(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.schemes.approveAndSend(id, session.userId);
  }

  @Post('drafts/:id/reject')
  reject(@CurrentTenantSession() session: TenantSession, @Param('id') id: string) {
    return this.approval.reject(id, session.userId);
  }
}
