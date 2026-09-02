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
import { Input } from '@/components/ui/input';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from 'recharts';
import { toast } from 'sonner';
import { Mail, RotateCw } from 'lucide-react';

type Interaction = {
  id: string;
  dealerId: string;
  direction: 'OUTBOUND' | 'INBOUND';
  status: string;
  subject: string;
  toAddress: string;
  errorText: string | null;
  body: string;
  createdAt: string;
  providerMessageId: string | null;
  dealer: { businessName: string } | null;
};

type FailedDraft = {
  id: string;
  subject: string;
  draftText: string;
  lastSendError: string | null;
  sendAttempts: number;
  updatedAt: string;
  dealer: { businessName: string; emails: { address: string }[] } | null;
};

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<Interaction | null>(null);
  const [rangeDays, setRangeDays] = useState('30');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [failed, setFailed] = useState<FailedDraft[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);

  function load() {
    apiFetch<Interaction[]>('/outreach-email/interactions')
      .then(setInteractions)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load history'));
    apiFetch<FailedDraft[]>('/outreach-email/failed')
      .then(setFailed)
      .catch(() => setFailed([]));
  }

  useEffect(load, []);

  async function retry(draftId: string) {
    setRetrying(draftId);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/retry`, { method: 'POST' });
      toast.success('Sent');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Retry failed');
    } finally {
      setRetrying(null);
    }
  }

  const filtered = useMemo(() => {
    if (!interactions) return [];
    const days = Number(rangeDays);
    const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    const term = search.trim().toLowerCase();
    return interactions.filter((i) => {
      if (cutoff && new Date(i.createdAt).getTime() < cutoff) return false;
      if (statusFilter !== 'ALL' && i.status !== statusFilter) return false;
      if (!term) return true;
      return (
        (i.dealer?.businessName ?? '').toLowerCase().includes(term) ||
        (i.subject ?? '').toLowerCase().includes(term) ||
        (i.toAddress ?? '').toLowerCase().includes(term) ||
        i.body.toLowerCase().includes(term)
      );
    });
  }, [interactions, rangeDays, search, statusFilter]);

  const statuses = useMemo(
    () => ['ALL', ...Array.from(new Set((interactions ?? []).map((i) => i.status))).sort()],
    [interactions],
  );

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
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search company, subject, address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />
          <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
            <SelectTrigger className="w-36">
              <SelectValue>{statusFilter === 'ALL' ? 'All statuses' : statusFilter}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'ALL' ? 'All statuses' : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      </div>

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      {failed.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-destructive">
              <RotateCw className="size-4" />
              {failed.length} email{failed.length === 1 ? '' : 's'} failed to send
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {failed.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.dealer?.businessName ?? 'Unknown company'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {f.dealer?.emails?.[0]?.address ?? 'no address'} · {f.lastSendError}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={retrying === f.id} onClick={() => retry(f.id)}>
                  <RotateCw className="size-3.5" />
                  {retrying === f.id ? 'Retrying…' : 'Retry'}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

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
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {interactions === null ? (
              <TableRow>
                <TableCell colSpan={4}>
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
                  <TableCell className="font-medium">{i.dealer?.businessName ?? i.dealerId}</TableCell>
                  <TableCell className="max-w-[22rem] truncate text-muted-foreground">
                    {i.subject || <span className="italic">no subject</span>}
                  </TableCell>
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
            <DialogTitle>{openItem ? (openItem.dealer?.businessName ?? openItem.dealerId) : ''}</DialogTitle>
            <DialogDescription>
              {openItem && `Exactly what was ${openItem.direction === 'OUTBOUND' ? 'sent' : 'received'} — ${new Date(openItem.createdAt).toLocaleString()}`}
            </DialogDescription>
          </DialogHeader>
          {openItem && (
            <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
              {openItem.toAddress && (
                <p>
                  <span className="text-muted-foreground">To: </span>
                  {openItem.toAddress}
                </p>
              )}
              {openItem.subject && (
                <p>
                  <span className="text-muted-foreground">Subject: </span>
                  {openItem.subject}
                </p>
              )}
            </div>
          )}
          {openItem?.errorText && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Failed: {openItem.errorText}
            </p>
          )}
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
