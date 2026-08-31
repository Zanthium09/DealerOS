import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantAuthGuard } from '../../core/auth';
import { PRISMA } from '../../core/tenancy/tenancy.module';

/**
 * One aggregation endpoint for the dashboard home page's KPI cards and charts —
 * every number here is a read the individual pages already expose piecemeal
 * (dealers by stage, the approval queue count, sent history), assembled into one
 * call so the home page is not five separate round trips before it can render.
 */
@Controller('dashboard')
@UseGuards(TenantAuthGuard)
export class DashboardController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get('stats')
  async stats() {
    const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      dealersByStageRaw,
      totalDealers,
      pendingApprovalCount,
      recentInteractions,
      statusBreakdownRaw,
      activeSchedulesCount,
      identities,
      suppressionCount,
    ] = await Promise.all([
      this.prisma.dealer.groupBy({ by: ['pipelineStage'], _count: { _all: true } }),
      this.prisma.dealer.count(),
      this.prisma.messageDraft.count({ where: { status: 'PENDING' } }),
      this.prisma.interactionEvent.findMany({
        where: { channel: 'EMAIL', direction: 'OUTBOUND', status: 'SENT', createdAt: { gte: since14 } },
        select: { createdAt: true },
      }),
      this.prisma.interactionEvent.groupBy({
        by: ['status'],
        where: { channel: 'EMAIL', createdAt: { gte: since30 } },
        _count: { _all: true },
      }),
      this.prisma.outreachSchedule.count({ where: { enabled: true } }),
      this.prisma.sendingIdentity.findMany({ select: { verificationStatus: true } }),
      this.prisma.suppression.count(),
    ]);

    // Day-bucketed send counts for the last 14 days, zero-filled — a chart with gaps
    // for days with no sends is more useful than one that silently skips them.
    const sentByDay: Record<string, number> = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      sentByDay[d.toISOString().slice(0, 10)] = 0;
    }
    for (const row of recentInteractions) {
      const key = row.createdAt.toISOString().slice(0, 10);
      if (key in sentByDay) sentByDay[key]++;
    }

    return {
      dealersByStage: Object.fromEntries(dealersByStageRaw.map((r) => [r.pipelineStage, r._count._all])),
      totalDealers,
      pendingApprovalCount,
      sentLast14Days: Object.entries(sentByDay).map(([date, count]) => ({ date, count })),
      statusBreakdown: Object.fromEntries(statusBreakdownRaw.map((r) => [r.status, r._count._all])),
      activeSchedulesCount,
      sendingIdentities: {
        total: identities.length,
        verified: identities.filter((i) => i.verificationStatus === 'VERIFIED').length,
        hasAnyVerified: identities.some((i) => i.verificationStatus === 'VERIFIED'),
      },
      suppressionCount,
    };
  }
}
