'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Check, Moon, RefreshCw } from 'lucide-react';

type Settings = {
  enabled: boolean;
  thresholdDays: number;
  autoSendBelowAov: string | null;
  attributionWindowDays: number;
  lastScanAt: string | null;
  lastScanSummary: { activated: number; wentDormant: number; reactivated: number } | null;
};

type Overview = {
  settings: Settings;
  dormantCount: number;
  averageHistoricalOrderValue: number | null;
  reactivatedNow: number;
  reactivationsEver: number;
  reactivationsCreditedToNudge: number;
  dormant: { dealerId: string; businessName: string; city: string | null; daysSinceOrder: number | null; averageOrderValue: number | null }[];
};

type ScanResult = {
  dryRun: boolean;
  activated: number;
  wentDormant: { dealerId: string; businessName: string; daysSinceOrder: number; nudge: string }[];
  reactivated: { dealerId: string; businessName: string; creditedToNudge: boolean }[];
  noOrderHistory: number;
};

type Group = { dealerId: string; businessName: string; drafts: { id: string; subject: string; draftText: string }[] };

const inr = (n: number | null) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);

export default function DormancyPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [queue, setQueue] = useState<Group[] | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState('30');
  const [autoBelow, setAutoBelow] = useState('');
  const [window_, setWindow] = useState('30');

  const load = useCallback(() => {
    apiFetch<Overview>('/dormancy/overview')
      .then((o) => {
        setData(o);
        setThreshold(String(o.settings.thresholdDays));
        setAutoBelow(o.settings.autoSendBelowAov ? String(Number(o.settings.autoSendBelowAov)) : '');
        setWindow(String(o.settings.attributionWindowDays));
      })
      .catch((e) => toast.error(err(e, 'Failed to load')));
    apiFetch<Group[]>('/dormancy/queue').then(setQueue).catch(() => setQueue([]));
  }, []);
  useEffect(load, [load]);

  async function save(extra: object = {}) {
    try {
      await apiFetch('/dormancy/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          thresholdDays: Number(threshold),
          attributionWindowDays: Number(window_),
          autoSendBelowAov: autoBelow.trim() === '' ? null : Number(autoBelow),
          ...extra,
        }),
      });
      toast.success('Saved');
      load();
    } catch (e) {
      toast.error(err(e, 'Could not save'));
    }
  }

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      setResult(await apiFetch<ScanResult>('/dormancy/scan', { method: 'POST', body: JSON.stringify({ dryRun }) }));
      if (!dryRun) load();
    } catch (e) {
      toast.error(err(e, 'Scan failed'));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, what: 'approve' | 'reject') {
    try {
      await apiFetch(`/dormancy/drafts/${id}/${what}`, { method: 'POST' });
      if (what === 'approve') toast.success('Sent');
    } catch (e) {
      toast.error(err(e, 'Failed'));
    }
    load();
  }

  const s = data?.settings;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Dormant dealers</h1>
        <p className="text-sm text-muted-foreground">
          Dealers who have stopped ordering, a check-in message to bring them back, and a record of who did come back. It needs your order history — import it
          under Data Sync first.
        </p>
      </div>

      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Dormant now" value={String(data.dormantCount)} />
            <Stat label="Their average order" value={inr(data.averageHistoricalOrderValue)} />
            <Stat label="Reactivated" value={String(data.reactivationsEver)} sub={`${data.reactivationsCreditedToNudge} after our nudge`} />
            <Stat label="Last scan" value={s?.lastScanAt ? new Date(s.lastScanAt).toLocaleDateString() : 'never'} sub={s?.enabled ? 'runs daily' : 'switched off'} />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Moon className="size-4" /> Settings
              </CardTitle>
              <CardDescription>
                Off until you switch it on. Use &ldquo;Preview&rdquo; first to see exactly who would be marked dormant — nothing is changed or sent by a preview.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Dormant after (days without an order)</Label>
                  <Input type="number" min={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Send without review if average order is below ₹</Label>
                  <Input type="number" min={0} placeholder="blank = always review" value={autoBelow} onChange={(e) => setAutoBelow(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Credit a comeback to our nudge within (days)</Label>
                  <Input type="number" min={1} value={window_} onChange={(e) => setWindow(e.target.value)} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => save()}>
                  Save settings
                </Button>
                <Button variant={s?.enabled ? 'destructive' : 'default'} onClick={() => save({ enabled: !s?.enabled })}>
                  {s?.enabled ? 'Switch off' : 'Switch on'}
                </Button>
                <span className="mx-1 text-muted-foreground">|</span>
                <Button variant="outline" disabled={busy} onClick={() => run(true)}>
                  <RefreshCw className="size-3.5" /> Preview
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => run(false)}>
                  Run scan now
                </Button>
              </div>
              {result && (
                <div className="rounded-lg bg-muted/50 p-3 text-sm">
                  <p className="font-medium">{result.dryRun ? 'Preview — nothing was changed' : 'Scan finished'}</p>
                  <p className="text-muted-foreground">
                    {result.wentDormant.length} {result.dryRun ? 'would go' : 'went'} dormant · {result.reactivated.length} {result.dryRun ? 'would be' : ''} reactivated ·{' '}
                    {result.activated} became active · {result.noOrderHistory} skipped (no orders on record)
                  </p>
                  {result.wentDormant.slice(0, 15).map((w) => (
                    <p key={w.dealerId} className="text-xs">
                      {w.businessName} — {w.daysSinceOrder} days{result.dryRun ? '' : ` · ${w.nudge}`}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Check-ins waiting for you</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {queue === null ? (
                <Skeleton className="h-16 w-full" />
              ) : queue.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing waiting.</p>
              ) : (
                queue.flatMap((g) =>
                  g.drafts.map((d) => (
                    <div key={d.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                      <div className="min-w-0">
                        <p className="font-medium">{g.businessName}</p>
                        <p className="text-xs text-muted-foreground">{d.subject}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{d.draftText}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" onClick={() => decide(d.id, 'approve')}>
                          <Check className="size-3.5" /> Send
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => decide(d.id, 'reject')}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  )),
                )
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Dormant dealers</CardTitle>
              <CardDescription>Highest historical value first.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.dormant.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">None yet.</p>
              ) : (
                data.dormant.map((d) => (
                  <div key={d.dealerId} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span className="truncate font-medium">
                      {d.businessName}
                      {d.city ? <span className="font-normal text-muted-foreground"> · {d.city}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      {d.daysSinceOrder != null && <Badge variant="outline">{d.daysSinceOrder}d quiet</Badge>}
                      avg {inr(d.averageOrderValue)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card size="sm">
      <CardContent className="px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
