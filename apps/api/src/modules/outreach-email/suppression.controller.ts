import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantAuthGuard } from '../../core/auth';
import { PRISMA } from '../../core/tenancy/tenancy.module';
import { getOrgId } from '../../core/tenancy/tenancy';

/**
 * §4 — Suppression is scoped per organization by construction here: every read and
 * write goes through the tenancy-scoped PRISMA client, the same guarantee every other
 * table in this app gets. Most rows are written automatically (a bounce, a reply
 * saying "unsubscribe" — see inbound.service.ts / webhook.service.ts); this is the
 * manual side, for a number a staff member is told about by phone, or a mistake
 * someone wants reversed.
 */
@Controller('outreach-email/suppressions')
@UseGuards(TenantAuthGuard)
export class SuppressionController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  list() {
    return this.prisma.suppression.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  }

  @Post()
  create(@Body() body: { email?: string; phoneE164?: string; reason: string }) {
    if (!body.email?.trim() && !body.phoneE164?.trim()) {
      throw new BadRequestException('email or phoneE164 is required');
    }
    if (!body.reason?.trim()) throw new BadRequestException('reason is required');
    return this.prisma.suppression.create({
      data: {
        organizationId: getOrgId()!,
        email: body.email?.trim().toLowerCase() || null,
        phoneE164: body.phoneE164?.trim() || null,
        reason: body.reason.trim(),
      },
    });
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.prisma.suppression.delete({ where: { id } });
    return { ok: true };
  }
}
