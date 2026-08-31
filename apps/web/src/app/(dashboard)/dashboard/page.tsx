'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Users, ClipboardCheck, Send, CalendarClock, TriangleAlert, Upload, Mail, Plus } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

type Stats = {
  dealersByStage: Record<string, number>;
  totalDealers: number;
  pendingApprovalCount: number;
  sentLast14Days: { date: string; count: number }[];
  statusBreakdown: Record<string, number>;
  activeSchedulesCount: number;
  sendingIdentities: { total: number; verified: number; hasAnyVerified: boolean };
  suppressionCount: number;
};

const STAGE_ORDER = ['NEW', 'CONTACTED', 'INTERESTED', 'ONBOARDED', 'ACTIVE', 'DORMANT', 'REACTIVATED'];
const TERMINAL_STAGES = ['OPTED_OUT', 'INVALID'];

const NEGATIVE_STATUSES = new Set(['BOUNCED', 'FAILED', 'COMPLAINED']);
const STATUS_ORDER = ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED', 'FAILED', 'COMPLAINED'];

function KpiCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-semibold tabular-nums leading-none">{value.toLocaleString()}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDay(date: string) {
  const d = new Date(date + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Stats>('/dashboard/stats')
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard'));
  }, []);

  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Could not load the dashboard</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!stats) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-72" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }

  const sentTotal14d = stats.sentLast14Days.reduce((sum, d) => sum + d.count, 0);
  const maxStageCount = Math.max(1, ...STAGE_ORDER.map((s) => stats.dealersByStage[s] ?? 0));
  const maxStatusCount = Math.max(1, ...STATUS_ORDER.map((s) => stats.statusBreakdown[s] ?? 0));

  return (
    <div className="space-y-6">
      {!stats.sendingIdentities.hasAnyVerified && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Outreach can&apos;t send yet</AlertTitle>
          <AlertDescription>
            No sending identity is verified — cold email outreach is blocked until one is set up.{' '}
            <Link href="/settings">Go to Settings</Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard icon={Users} label="Total dealers" value={stats.totalDealers} />
        <KpiCard icon={ClipboardCheck} label="Pending approvals" value={stats.pendingApprovalCount} />
        <KpiCard icon={Send} label="Sent (last 14 days)" value={sentTotal14d} />
        <KpiCard icon={CalendarClock} label="Active schedules" value={stats.activeSchedulesCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Emails sent, last 14 days</CardTitle>
          <CardDescription>Outbound cold-outreach emails per day</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.sentLast14Days} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="sentFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDay}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip
                  labelFormatter={(v) => formatDay(String(v))}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  name="Sent"
                  stroke="hsl(var(--chart-2))"
                  fill="url(#sentFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>Dealers by stage</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {STAGE_ORDER.map((stage) => {
              const count = stats.dealersByStage[stage] ?? 0;
              return (
                <div key={stage} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 text-muted-foreground">{stage}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(count / maxStageCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right font-medium tabular-nums">{count}</span>
                </div>
              );
            })}
            {TERMINAL_STAGES.some((s) => stats.dealersByStage[s]) && (
              <div className="flex flex-wrap gap-2 pt-2">
                {TERMINAL_STAGES.map((s) =>
                  stats.dealersByStage[s] ? (
                    <Badge key={s} variant="secondary" className="text-muted-foreground">
                      {s}: {stats.dealersByStage[s]}
                    </Badge>
                  ) : null,
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Email status, last 30 days</CardTitle>
            <CardDescription>Delivery and engagement outcomes</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {STATUS_ORDER.map((status) => {
              const count = stats.statusBreakdown[status] ?? 0;
              const negative = NEGATIVE_STATUSES.has(status);
              return (
                <div key={status} className="flex items-center gap-3 text-sm">
                  <span className="w-20 shrink-0 text-muted-foreground">{status}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={negative ? 'h-full rounded-full bg-destructive' : 'h-full rounded-full bg-primary'}
                      style={{ width: `${(count / maxStatusCount) * 100}%` }}
                    />
                  </div>
                  <span
                    className={
                      negative
                        ? 'w-8 shrink-0 text-right font-medium tabular-nums text-destructive'
                        : 'w-8 shrink-0 text-right font-medium tabular-nums'
                    }
                  >
                    {count}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card size="sm">
          <CardContent className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Suppressed contacts</span>
            <span className="text-lg font-semibold tabular-nums">{stats.suppressionCount}</span>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Sending identities</span>
            <span className="text-lg font-semibold tabular-nums">
              {stats.sendingIdentities.verified}/{stats.sendingIdentities.total} verified
            </span>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          {/* nativeButton=false: an <a> (via Link) is standing in for the button,
              not a real <button> — Base UI's Button defaults to expecting a native
              one and warns otherwise. */}
          <Button variant="outline" nativeButton={false} render={<Link href="/dealers" />}>
            <Upload /> Import Dealers
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/dealers" />}>
            <Mail /> Run Cold Outreach
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/schedules" />}>
            <Plus /> New Schedule
          </Button>
        </div>
      </div>
    </div>
  );
}
