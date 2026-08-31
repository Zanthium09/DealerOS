'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from 'recharts';
import { Mail } from 'lucide-react';

type Interaction = {
  id: string;
  dealerId: string;
  direction: 'OUTBOUND' | 'INBOUND';
  status: string;
  body: string;
  createdAt: string;
  providerMessageId: string | null;
};

type Dealer = { id: string; businessName: string };

const STATUS_VARIANT: Record<string, 'secondary' | 'default' | 'destructive' | 'outline'> = {
  SENT: 'secondary',
  DELIVERED: 'secondary',
  OPENED: 'default',
  CLICKED: 'default',
  REPLIED: 'default',
  BOUNCED: 'destructive',
  FAILED: 'destructive',
  COMPLAINED: 'destructive',
};

const STATUS_CLASS: Record<string, string> = {
  OPENED: 'bg-blue-600 text-white',
  CLICKED: 'bg-blue-600 text-white',
  REPLIED: 'bg-green-600 text-white',
};

const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: 0 },
];

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export default function SentPage() {
  const [interactions, setInteractions] = useState<Interaction[] | null>(null);
  const [dealerNames, setDealerNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<Interaction | null>(null);
  const [rangeDays, setRangeDays] = useState('30');

  useEffect(() => {
    apiFetch<Interaction[]>('/outreach-email/interactions')
      .then(setInteractions)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load history'));
    apiFetch<Dealer[]>('/contacts')
      .then((dealers) => setDealerNames(Object.fromEntries(dealers.map((d) => [d.id, d.businessName]))))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (!interactions) return [];
    const days = Number(rangeDays);
    if (!days) return interactions;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return interactions.filter((i) => new Date(i.createdAt).getTime() >= cutoff);
  }, [interactions, rangeDays]);

  const stats = useMemo(() => {
    const outbound = filtered.filter((i) => i.direction === 'OUTBOUND');
    const total = outbound.length;
    const opened = outbound.filter((i) => ['OPENED', 'CLICKED', 'REPLIED'].includes(i.status)).length;
    const replied = outbound.filter((i) => i.status === 'REPLIED').length;
    const bounced = outbound.filter((i) => i.status === 'BOUNCED').length;
    const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
    return { total, openRate: pct(opened), replyRate: pct(replied), bounceRate: pct(bounced) };
  }, [filtered]);

  const statusBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach((i) => {
      counts[i.status] = (counts[i.status] ?? 0) + 1;
    });
    return Object.entries(counts).map(([status, count]) => ({ status, count }));
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Sent / History</h1>
          <p className="text-sm text-muted-foreground">Every email sent and received, exactly as it went out.</p>
        </div>
        <Select value={rangeDays} onValueChange={(v) => v && setRangeDays(v)}>
          <SelectTrigger className="w-40">
            <SelectValue>{RANGES.find((r) => String(r.days) === rangeDays)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.days} value={String(r.days)}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      {interactions !== null && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total sent" value={String(stats.total)} />
          <StatCard label="Open rate" value={`${stats.openRate}%`} />
          <StatCard label="Reply rate" value={`${stats.replyRate}%`} />
          <StatCard label="Bounce rate" value={`${stats.bounceRate}%`} tone={stats.bounceRate > 0 ? 'warn' : undefined} />
        </div>
      )}

      {interactions !== null && statusBreakdown.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Status breakdown</CardTitle>
          </CardHeader>
          <CardContent className="h-48 px-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusBreakdown} layout="vertical" margin={{ left: 8, right: 16 }}>
                <XAxis type="number" hide />
                <YAxis
                  dataKey="status"
                  type="category"
                  width={90}
                  tick={{ fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {statusBreakdown.map((entry, idx) => (
                    <Cell key={entry.status} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Dealer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {interactions === null ? (
              <TableRow>
                <TableCell colSpan={3}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Mail className="size-8" />
                    Nothing sent in this range.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((i) => (
                <TableRow key={i.id} className="cursor-pointer" onClick={() => setOpenItem(i)}>
                  <TableCell className="font-medium">{dealerNames[i.dealerId] ?? i.dealerId}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[i.status] ?? 'outline'} className={STATUS_CLASS[i.status]}>
                      {i.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(i.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={!!openItem} onOpenChange={(open) => !open && setOpenItem(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{openItem ? dealerNames[openItem.dealerId] ?? openItem.dealerId : ''}</DialogTitle>
            <DialogDescription>
              {openItem && `Exactly what was ${openItem.direction === 'OUTBOUND' ? 'sent' : 'received'} — ${new Date(openItem.createdAt).toLocaleString()}`}
            </DialogDescription>
          </DialogHeader>
          <p className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm">{openItem?.body}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <Card size="sm">
      <CardContent className="px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold ${tone === 'warn' ? 'text-destructive' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
