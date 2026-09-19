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
import { Check, Tag } from 'lucide-react';

type Scheme = {
  id: string;
  name: string;
  terms: string;
  status: 'DRAFT' | 'ACTIVE' | 'ENDED';
  validFrom: string;
  validTo: string;
  applicableProductIds: string[];
  targeted: number;
  announced: number;
  attributedOrders: number;
  attributedRevenue: number;
  dealersWhoOrdered: number;
};
type Product = { id: string; sku: string; name: string; category: string | null };
type Group = { dealerId: string; businessName: string; drafts: { id: string; subject: string; draftText: string }[] };

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const day = (s: string) => new Date(s).toLocaleDateString();
const err = (e: unknown, f: string) => (e instanceof ApiError ? e.message : f);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const EMPTY = { name: '', terms: '', validFrom: '', validTo: '', categories: '', states: '', cities: '', within: '', productIds: [] as string[] };

export default function SchemesPage() {
  const [schemes, setSchemes] = useState<Scheme[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [queue, setQueue] = useState<Group[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [info, setInfo] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    apiFetch<Scheme[]>('/schemes').then(setSchemes).catch((e) => toast.error(err(e, 'Failed to load')));
    apiFetch<Group[]>('/schemes/queue/pending').then(setQueue).catch(() => setQueue([]));
  }, []);
  useEffect(() => {
    load();
    apiFetch<Product[]>('/schemes/products').then(setProducts).catch(() => setProducts([]));
  }, [load]);

  async function create() {
    const rule: Record<string, unknown> = {};
    if (list(form.categories).length) rule.categories = list(form.categories);
    if (list(form.states).length) rule.states = list(form.states);
    if (list(form.cities).length) rule.cities = list(form.cities);
    if (form.within.trim()) rule.boughtSchemeProductsWithinDays = Number(form.within);
    try {
      await apiFetch('/schemes', {
        method: 'POST',
        body: JSON.stringify({ name: form.name, terms: form.terms, validFrom: form.validFrom, validTo: form.validTo, applicableProductIds: form.productIds, targetSegmentRule: rule }),
      });
      toast.success('Scheme saved as a draft');
      setForm(EMPTY);
      load();
    } catch (e) {
      toast.error(err(e, 'Could not save'));
    }
  }

  async function act(id: string, path: string, body?: object, ok?: (r: any) => string) {
    try {
      const r = await apiFetch<any>(`/schemes/${id}${path}`, { method: path === '' ? 'DELETE' : path === '/preview' ? 'GET' : 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      if (ok) setInfo((i) => ({ ...i, [id]: ok(r) }));
      load();
    } catch (e) {
      toast.error(err(e, 'Failed'));
    }
  }

  async function decide(id: string, what: 'approve' | 'reject') {
    try {
      await apiFetch(`/schemes/drafts/${id}/${what}`, { method: 'POST' });
      if (what === 'approve') toast.success('Sent');
    } catch (e) {
      toast.error(err(e, 'Failed'));
    }
    load();
  }

  const toggle = (id: string) => setForm((f) => ({ ...f, productIds: f.productIds.includes(id) ? f.productIds.filter((x) => x !== id) : [...f.productIds, id] }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Schemes</h1>
        <p className="text-sm text-muted-foreground">
          Create a scheme, pick who it is for, announce it, and see how much business it brought in. The terms are shown to dealers exactly as you write them, and every
          announcement waits for your approval. Needs your products and orders imported under Data Sync.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="size-4" /> New scheme
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Terms, exactly as dealers should read them</Label>
              <Input value={form.terms} placeholder="e.g. Buy 10 cases, get 1 free" onChange={(e) => setForm({ ...form, terms: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Valid from</Label>
              <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Valid to</Label>
              <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Products on scheme</Label>
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">No products yet — import your product list under Data Sync.</p>
            ) : (
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {products.map((p) => (
                  <Button key={p.id} size="sm" variant={form.productIds.includes(p.id) ? 'default' : 'outline'} onClick={() => toggle(p.id)}>
                    {p.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Categories (comma-separated)</Label>
              <Input value={form.categories} onChange={(e) => setForm({ ...form, categories: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>States</Label>
              <Input value={form.states} onChange={(e) => setForm({ ...form, states: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Cities</Label>
              <Input value={form.cities} onChange={(e) => setForm({ ...form, cities: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Bought these products in last (days)</Label>
              <Input type="number" min={1} value={form.within} onChange={(e) => setForm({ ...form, within: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Leave the audience boxes blank to target every dealer who has bought from you.</p>
          <Button onClick={create}>Save draft</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Announcements waiting for you</CardTitle>
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
          <CardTitle className="text-base">Your schemes</CardTitle>
          <CardDescription>Orders are credited to a scheme when the dealer was targeted, the order is inside the dates, and it includes a scheme product. Updated daily.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {schemes === null ? (
            <Skeleton className="h-16 w-full" />
          ) : schemes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No schemes yet.</p>
          ) : (
            schemes.map((s) => (
              <div key={s.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {s.name} <Badge variant={s.status === 'ACTIVE' ? 'default' : 'outline'}>{s.status.toLowerCase()}</Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.terms} · {day(s.validFrom)} to {day(s.validTo)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {s.status === 'DRAFT' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => act(s.id, '/preview', undefined, (r) => `${r.count} dealers match`)}>
                          Preview audience
                        </Button>
                        <Button size="sm" onClick={() => act(s.id, '/activate', {}, (r) => `Activated for ${r.recipients} dealers`)}>
                          Activate
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => act(s.id, '')}>
                          Delete
                        </Button>
                      </>
                    )}
                    {s.status === 'ACTIVE' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => act(s.id, '/broadcast', { dryRun: true }, (r) => `Would draft ${r.drafted}, ${r.alreadyDrafted} already drafted, ${r.skipped.length} skipped`)}>
                          Preview announcement
                        </Button>
                        <Button size="sm" onClick={() => act(s.id, '/broadcast', {}, (r) => `Drafted ${r.drafted} for your approval, ${r.skipped.length} skipped`)}>
                          Draft announcements
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => act(s.id, '/end')}>
                          End
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {info[s.id] && <p className="text-xs text-muted-foreground">{info[s.id]}</p>}
                {s.status !== 'DRAFT' && (
                  <p className="text-xs text-muted-foreground">
                    Targeted {s.targeted} · announced {s.announced} · {s.dealersWhoOrdered} dealers ordered · {s.attributedOrders} orders · {inr(s.attributedRevenue)}
                  </p>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
