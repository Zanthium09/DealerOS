'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Bot, X } from 'lucide-react';

type Overview = {
  settings: { enabled: boolean; pilotLimit: number; maxLineQuantity: number; draftExpiryMinutes: number };
  pilot: { dealerId: string; businessName: string; city: string | null }[];
  funnel: { started: number; confirmed: number; cancelled: number; expired: number; open: number };
  orders: { id: string; businessName: string; orderDate: string; totalValue: number; lines: { sku: string; productName: string; quantity: number }[] }[];
};
type Dealer = { id: string; businessName: string; city: string | null };

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);

export default function OrderingBotPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [form, setForm] = useState({ pilotLimit: '30', maxLineQuantity: '500', draftExpiryMinutes: '120' });
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<Dealer[]>([]);

  const load = useCallback(() => {
    apiFetch<Overview>('/ordering-bot/overview')
      .then((o) => {
        setData(o);
        setForm({ pilotLimit: String(o.settings.pilotLimit), maxLineQuantity: String(o.settings.maxLineQuantity), draftExpiryMinutes: String(o.settings.draftExpiryMinutes) });
      })
      .catch((e) => toast.error(err(e, 'Failed to load')));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (term.trim().length < 2) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      apiFetch<Dealer[]>(`/contacts?search=${encodeURIComponent(term.trim())}&take=8`).then(setFound).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  async function save(extra: object = {}) {
    try {
      await apiFetch('/ordering-bot/settings', {
        method: 'PATCH',
        body: JSON.stringify({ pilotLimit: Number(form.pilotLimit), maxLineQuantity: Number(form.maxLineQuantity), draftExpiryMinutes: Number(form.draftExpiryMinutes), ...extra }),
      });
      toast.success('Saved');
      load();
    } catch (e) {
      toast.error(err(e, 'Could not save'));
    }
  }

  async function enroll(id: string) {
    try {
      await apiFetch(`/ordering-bot/pilot/${id}`, { method: 'POST' });
      setTerm('');
      load();
    } catch (e) {
      toast.error(err(e, 'Could not enrol'));
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/ordering-bot/pilot/${id}`, { method: 'DELETE' });
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
        <h1 className="text-lg font-semibold">Ordering bot</h1>
        <p className="text-sm text-muted-foreground">
          A pilot: pick a few dealers comfortable with WhatsApp and they can place orders by message. Nothing becomes an order until the dealer replies CONFIRM, they can ask for a
          person at any time, and every reply is scripted — no AI reads or writes these messages. Needs WhatsApp connected and your product prices imported.
        </p>
      </div>

      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Pilot dealers" value={`${data.pilot.length} / ${data.settings.pilotLimit}`} />
            <Stat label="Orders started" value={String(data.funnel.started)} />
            <Stat label="Confirmed" value={String(data.funnel.confirmed)} sub={data.funnel.started ? `${Math.round((data.funnel.confirmed / data.funnel.started) * 100)}% finished` : undefined} />
            <Stat label="Dropped" value={String(data.funnel.cancelled + data.funnel.expired)} sub="cancelled or expired" />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="size-4" /> Settings
              </CardTitle>
              <CardDescription>Off until you switch it on.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {field('pilotLimit', 'Most dealers in the pilot')}
                {field('maxLineQuantity', 'Largest quantity per item by message')}
                {field('draftExpiryMinutes', 'Unconfirmed order lapses after (minutes)')}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => save()}>
                  Save settings
                </Button>
                <Button variant={s?.enabled ? 'destructive' : 'default'} onClick={() => save({ enabled: !s?.enabled })}>
                  {s?.enabled ? 'Switch off' : 'Switch on'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pilot dealers</CardTitle>
              <CardDescription>Only these dealers get the bot. Anyone else who messages goes to the normal inbox.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input placeholder="Search a dealer to add…" value={term} onChange={(e) => setTerm(e.target.value)} />
              {found.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <span>
                    {d.businessName}
                    {d.city ? <span className="text-muted-foreground"> · {d.city}</span> : null}
                  </span>
                  <Button size="sm" onClick={() => enroll(d.id)}>
                    Add
                  </Button>
                </div>
              ))}
              {data.pilot.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No dealers in the pilot yet.</p>
              ) : (
                data.pilot.map((p) => (
                  <div key={p.dealerId} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                    <span>
                      {p.businessName}
                      {p.city ? <span className="text-muted-foreground"> · {p.city}</span> : null}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => remove(p.dealerId)} aria-label="Remove from pilot">
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Orders placed by the bot</CardTitle>
              <CardDescription>These are ordinary orders — they appear with the rest of your order history.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {data.orders.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">None yet.</p>
              ) : (
                data.orders.map((o) => (
                  <div key={o.id} className="rounded-lg border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{o.businessName}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(o.orderDate).toLocaleString()} · {inr(o.totalValue)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{o.lines.map((l) => `${l.productName} × ${l.quantity}`).join(', ')}</p>
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
