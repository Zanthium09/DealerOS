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
import { Check, RefreshCw, Wallet } from 'lucide-react';

type Settings = {
  enabled: boolean;
  gentleAfterDays: number;
  firmAfterDays: number;
  humanAfterDays: number;
  reminderIntervalDays: number;
  freshnessWindowHours: number;
  lastRunAt: string | null;
};

type Overview = {
  settings: Settings;
  paymentsSyncedAt: string | null;
  dataFresh: boolean;
  staleReason: string | null;
  buckets: Record<'CURRENT' | 'D30' | 'D60' | 'D90_PLUS', { amount: number; invoices: number }>;
  cases: {
    id: string;
    dealerId: string;
    level: 'GENTLE' | 'FIRM' | 'HUMAN';
    outstanding: number;
    overdueInvoices: number;
    oldestDaysOverdue: number;
    needsCall: boolean;
    callReason: string | null;
    dealer: { businessName: string; city: string | null };
  }[];
};

type RunResult = {
  dryRun: boolean;
  refused: string | null;
  dealersWithOverdue: number;
  remindersDrafted: { dealerId: string; businessName: string; level: string; amountDue: number }[];
  flaggedForCall: { dealerId: string; businessName: string; reason: string }[];
  skipped: { dealerId: string; businessName: string; reason: string }[];
  cleared: number;
};

type Group = { dealerId: string; businessName: string; drafts: { id: string; subject: string; draftText: string }[] };

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);
const LABEL = { CURRENT: 'Not yet due', D30: '1–30 days', D60: '31–60 days', D90_PLUS: '60+ days' } as const;

export default function CollectionsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [queue, setQueue] = useState<Group[] | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ gentleAfterDays: '7', firmAfterDays: '30', humanAfterDays: '60', reminderIntervalDays: '7', freshnessWindowHours: '48' });

  const load = useCallback(() => {
    apiFetch<Overview>('/collections/overview')
      .then((o) => {
        setData(o);
        const s = o.settings;
        setForm({
          gentleAfterDays: String(s.gentleAfterDays),
          firmAfterDays: String(s.firmAfterDays),
          humanAfterDays: String(s.humanAfterDays),
          reminderIntervalDays: String(s.reminderIntervalDays),
          freshnessWindowHours: String(s.freshnessWindowHours),
        });
      })
      .catch((e) => toast.error(err(e, 'Failed to load')));
    apiFetch<Group[]>('/collections/queue').then(setQueue).catch(() => setQueue([]));
  }, []);
  useEffect(load, [load]);

  async function save(extra: object = {}) {
    try {
      await apiFetch('/collections/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])), ...extra }),
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
      setResult(await apiFetch<RunResult>('/collections/run', { method: 'POST', body: JSON.stringify({ dryRun }) }));
      if (!dryRun) load();
    } catch (e) {
      toast.error(err(e, 'Run failed'));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, what: 'approve' | 'reject') {
    try {
      await apiFetch(`/collections/drafts/${id}/${what}`, { method: 'POST' });
      if (what === 'approve') toast.success('Sent');
    } catch (e) {
      toast.error(err(e, 'Failed'));
    }
    load();
  }

  async function handled(dealerId: string) {
    try {
      await apiFetch(`/collections/dealers/${dealerId}/acknowledge`, { method: 'POST' });
      load();
    } catch (e) {
      toast.error(err(e, 'Failed'));
    }
  }

  const s = data?.settings;
  const field = (k: keyof typeof form, label: string) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" min={1} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Collections</h1>
        <p className="text-sm text-muted-foreground">
          Overdue payments, a polite then firmer reminder, and a call flag for the long-overdue. Every reminder waits for your approval, and the final step is always a
          person&rsquo;s call. Needs your dues imported under Data Sync.
        </p>
      </div>

      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {!data.dataFresh && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium">Reminders are paused</p>
              <p className="text-muted-foreground">{data.staleReason}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => (
              <Stat key={k} label={LABEL[k]} value={inr(data.buckets[k].amount)} sub={`${data.buckets[k].invoices} invoices`} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Payment data last synced: {data.paymentsSyncedAt ? new Date(data.paymentsSyncedAt).toLocaleString() : 'never'}
          </p>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Wallet className="size-4" /> Settings
              </CardTitle>
              <CardDescription>Off until you switch it on. &ldquo;Preview&rdquo; shows who would be reminded or flagged — it changes and sends nothing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {field('gentleAfterDays', 'Gentle reminder after (days overdue)')}
                {field('firmAfterDays', 'Firm reminder after (days)')}
                {field('humanAfterDays', 'Flag for a call after (days)')}
                {field('reminderIntervalDays', 'Repeat no sooner than (days)')}
                {field('freshnessWindowHours', 'Payment data must be newer than (hours)')}
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
                  Run now
                </Button>
              </div>
              {result && (
                <div className="rounded-lg bg-muted/50 p-3 text-sm">
                  {result.refused ? (
                    <p className="text-muted-foreground">{result.refused}</p>
                  ) : (
                    <>
                      <p className="font-medium">{result.dryRun ? 'Preview — nothing was changed' : 'Run finished'}</p>
                      <p className="text-muted-foreground">
                        {result.dealersWithOverdue} dealers overdue · {result.remindersDrafted.length} reminders {result.dryRun ? 'would be drafted' : 'drafted'} ·{' '}
                        {result.flaggedForCall.length} for a call · {result.skipped.length} skipped
                      </p>
                      {result.remindersDrafted.slice(0, 15).map((r) => (
                        <p key={r.dealerId} className="text-xs">
                          {r.businessName} — {r.level.toLowerCase()}, {inr(r.amountDue)}
                        </p>
                      ))}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Reminders waiting for you</CardTitle>
              <CardDescription>Checked against the latest figures again when you press Send.</CardDescription>
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
              <CardTitle className="text-base">Dealers on the ladder</CardTitle>
              <CardDescription>Largest balance first. Those marked for a call also appear in the Calling queue.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.cases.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nobody overdue.</p>
              ) : (
                data.cases.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span className="truncate font-medium">
                      {c.dealer.businessName}
                      {c.dealer.city ? <span className="font-normal text-muted-foreground"> · {c.dealer.city}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={c.level === 'HUMAN' ? 'destructive' : 'outline'}>{c.level.toLowerCase()}</Badge>
                      {c.oldestDaysOverdue}d · {inr(c.outstanding)}
                      {c.needsCall && (
                        <Button size="sm" variant="outline" onClick={() => handled(c.dealerId)}>
                          Call done
                        </Button>
                      )}
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
