'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { stageBadgeClass } from '@/lib/badge-styles';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, Phone, PhoneOff } from 'lucide-react';

type QueueItem = {
  dealerId: string;
  businessName: string;
  city: string | null;
  contactPersonName: string | null;
  phone: string | null;
  stage: string;
  reason: string;
  followUpDue: string | null;
};

type Brief = {
  dealer: { id: string; businessName: string; contactPersonName: string | null; city: string | null; category: string | null; stage: string; notes: string | null };
  callTo: string | null;
  doNotCall: boolean;
  alternatePhones: (string | null)[];
  relationship: {
    ordersPlaced: number;
    lifetimeRevenue: string | null;
    lastOrder: string | null;
    daysSinceLastOrder: number | null;
    outstanding: string | null;
    overdue: string | null;
    averageDaysToPay: number | null;
  };
  timeline: { at: string; channel: string; direction: 'INBOUND' | 'OUTBOUND'; body: string }[];
  previousCalls: { at: string; outcome: string; notes: string | null }[];
  talkingPoints: string[] | null;
  talkingPointsNote: string | null;
};

type FollowUp = { id: string; followUpAt: string; notes: string | null; dealer: { id: string; businessName: string } };

const OUTCOMES: { value: string; label: string }[] = [
  { value: 'SPOKE_INTERESTED', label: 'Spoke — interested' },
  { value: 'SPOKE_CALL_BACK', label: 'Spoke — call back later' },
  { value: 'SPOKE_NOT_INTERESTED', label: 'Spoke — not interested' },
  { value: 'ONBOARDED', label: 'Onboarded' },
  { value: 'NO_ANSWER', label: 'No answer' },
  { value: 'WRONG_NUMBER', label: 'Wrong number' },
  { value: 'DO_NOT_CALL', label: 'Asked not to be called' },
];

const label = (o: string) => OUTCOMES.find((x) => x.value === o)?.label ?? o.replace(/_/g, ' ').toLowerCase();
const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);

export default function CallingPage() {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch<QueueItem[]>('/calling/queue').then(setQueue).catch(() => setQueue([]));
    apiFetch<FollowUp[]>('/calling/follow-ups').then(setFollowUps).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function select(dealerId: string) {
    setOpen(dealerId);
    setBrief(null);
    setOutcome('');
    setNotes('');
    setFollowUpAt('');
    setBriefLoading(true);
    try {
      setBrief(await apiFetch<Brief>(`/calling/brief/${dealerId}`));
    } catch (e) {
      toast.error(err(e, 'Could not build the brief'));
    } finally {
      setBriefLoading(false);
    }
  }

  async function save() {
    if (!open || !outcome) return;
    setBusy(true);
    try {
      await apiFetch('/calling/log', {
        method: 'POST',
        body: JSON.stringify({ dealerId: open, outcome, notes, followUpAt: followUpAt ? new Date(followUpAt).toISOString() : undefined }),
      });
      toast.success('Call logged');
      setOpen(null);
      setBrief(null);
      load();
    } catch (e) {
      toast.error(err(e, 'Could not log the call'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Calling</h1>
        <p className="text-sm text-muted-foreground">
          Who to call next, a brief before you dial, and a place to record how it went. You make the call yourself — this doesn&apos;t place calls.
        </p>
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        Commercial calls in India can be subject to TRAI DND / DLT rules. Check what applies to your calls with your compliance advisor before scaling this up
        (CLAUDE.md §5.4). Anyone who asks not to be called is excluded from this list.
      </p>

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {followUps.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CalendarClock className="size-4" /> Promised call-backs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {followUps.map((f) => {
                  const overdue = new Date(f.followUpAt) <= new Date();
                  return (
                    <button key={f.id} onClick={() => select(f.dealer.id)} className="w-full rounded-lg border p-2 text-left text-sm hover:bg-accent">
                      <p className="font-medium">{f.dealer.businessName}</p>
                      <p className={`text-xs ${overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
                        {overdue ? 'Overdue — ' : ''}
                        {new Date(f.followUpAt).toLocaleString()}
                      </p>
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Call next</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {queue === null ? (
                <Skeleton className="h-24 w-full" />
              ) : queue.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  <Phone className="mx-auto mb-2 size-6" />
                  Nobody to call right now. Dealers who reply, or show interest, appear here.
                </p>
              ) : (
                queue.map((q) => (
                  <button
                    key={q.dealerId}
                    onClick={() => select(q.dealerId)}
                    className={`w-full rounded-lg border p-2 text-left text-sm transition-colors hover:bg-accent ${open === q.dealerId ? 'border-primary bg-accent' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{q.businessName}</span>
                      <Badge className={stageBadgeClass(q.stage)}>{q.stage}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {q.reason}
                      {q.city ? ` · ${q.city}` : ''}
                    </p>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          {!open ? (
            <CardContent className="py-16 text-center text-sm text-muted-foreground">Pick a dealer to see their brief.</CardContent>
          ) : briefLoading || !brief ? (
            <CardContent className="space-y-2 py-6">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </CardContent>
          ) : (
            <>
              <CardHeader className="pb-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {brief.dealer.businessName}
                  <Badge className={stageBadgeClass(brief.dealer.stage)}>{brief.dealer.stage}</Badge>
                </CardTitle>
                <CardDescription>
                  {[brief.dealer.contactPersonName, brief.dealer.city, brief.dealer.category].filter(Boolean).join(' · ')}
                </CardDescription>
                {brief.doNotCall ? (
                  <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                    <PhoneOff className="size-4" /> This dealer asked not to be called. Do not dial.
                  </p>
                ) : brief.callTo ? (
                  <a href={`tel:${brief.callTo}`} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
                    <Phone className="size-4" /> {brief.callTo}
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground">No valid phone number on file.</p>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Talking points</h3>
                  {brief.talkingPoints ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {brief.talkingPoints.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{brief.talkingPointsNote}</p>
                  )}
                </section>

                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relationship</h3>
                  {brief.relationship.ordersPlaced === 0 && !brief.relationship.outstanding ? (
                    <p className="text-sm text-muted-foreground">No orders or dues on record{' '}(import them under Data Sync).</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                      <Fact label="Orders" value={String(brief.relationship.ordersPlaced)} />
                      <Fact label="Lifetime" value={brief.relationship.lifetimeRevenue ?? '—'} />
                      <Fact label="Last order" value={brief.relationship.daysSinceLastOrder != null ? `${brief.relationship.daysSinceLastOrder}d ago` : '—'} />
                      <Fact label="Owes" value={brief.relationship.outstanding ?? '—'} tone={brief.relationship.overdue ? 'warn' : undefined} />
                    </div>
                  )}
                  {brief.relationship.overdue && <p className="text-xs font-medium text-destructive">{brief.relationship.overdue} of that is overdue.</p>}
                </section>

                {brief.previousCalls.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Previous calls</h3>
                    {brief.previousCalls.map((c, i) => (
                      <p key={i} className="text-sm">
                        <span className="text-muted-foreground">{new Date(c.at).toLocaleDateString()} · </span>
                        {label(c.outcome)}
                        {c.notes ? ` — ${c.notes}` : ''}
                      </p>
                    ))}
                  </section>
                )}

                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent messages</h3>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg bg-muted/40 p-2">
                    {brief.timeline.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Nothing yet.</p>
                    ) : (
                      brief.timeline.map((m, i) => (
                        <p key={i} className="text-xs">
                          <span className="font-medium">{m.direction === 'INBOUND' ? 'Dealer' : 'We'}</span>{' '}
                          <span className="text-muted-foreground">
                            ({m.channel.toLowerCase()}, {new Date(m.at).toLocaleDateString()})
                          </span>{' '}
                          {m.body}
                        </p>
                      ))
                    )}
                  </div>
                </section>

                <section className="space-y-3 border-t pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">How did it go?</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {OUTCOMES.map((o) => (
                      <Button key={o.value} size="sm" variant={outcome === o.value ? 'default' : 'outline'} onClick={() => setOutcome(o.value)}>
                        {o.label}
                      </Button>
                    ))}
                  </div>
                  <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (what they said, what you agreed)…" />
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1.5">
                      <Label>Call back on (optional)</Label>
                      <Input type="datetime-local" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
                    </div>
                    <Button disabled={busy || !outcome} onClick={save}>
                      Log call
                    </Button>
                  </div>
                </section>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-lg border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-medium ${tone === 'warn' ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  );
}
