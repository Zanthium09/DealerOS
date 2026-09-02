'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Megaphone, Play, Trash2, Users } from 'lucide-react';

type Campaign = {
  id: string;
  name: string;
  status: string;
  segmentFilter: Record<string, string>;
  templateId: string | null;
  createdAt: string;
};

type Template = { id: string; name: string };
type Preview = { total: number; sample: { id: string; businessName: string; city: string | null }[] };
type Stats = { audience: number; drafted: number; byStatus: Record<string, number> };

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [category, setCategory] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [creating, setCreating] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch<Campaign[]>('/outreach-email/campaigns')
      .then(setCampaigns)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load campaigns'));
  }, []);

  useEffect(() => {
    load();
    apiFetch<Template[]>('/outreach-email/templates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [load]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const segmentFilter: Record<string, string> = {};
      if (city.trim()) segmentFilter.city = city.trim();
      if (state.trim()) segmentFilter.state = state.trim();
      if (category.trim()) segmentFilter.businessCategory = category.trim();
      await apiFetch('/outreach-email/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name, segmentFilter, templateId: templateId || null }),
      });
      setName('');
      setCity('');
      setState('');
      setCategory('');
      setTemplateId('');
      load();
      toast.success('Campaign created');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create campaign');
    } finally {
      setCreating(false);
    }
  }

  async function open(id: string) {
    setOpenId(id);
    setPreview(null);
    setStats(null);
    const [p, s] = await Promise.allSettled([
      apiFetch<Preview>(`/outreach-email/campaigns/${id}/preview`),
      apiFetch<Stats>(`/outreach-email/campaigns/${id}/stats`),
    ]);
    if (p.status === 'fulfilled') setPreview(p.value);
    if (s.status === 'fulfilled') setStats(s.value);
  }

  async function run(id: string) {
    setBusy(true);
    try {
      const res = await apiFetch<{ drafted: number; sent: number }>(`/outreach-email/campaigns/${id}/run`, {
        method: 'POST',
        // Everything lands in the approval queue. A campaign is the largest blast
        // this app can fire, so it never auto-sends without a human seeing it.
        body: JSON.stringify({ forceReview: true }),
      });
      toast.success(`Drafted ${res.drafted} — review them in the Approval Queue`);
      open(id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Run failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/outreach-email/campaigns/${id}`, { method: 'DELETE' });
      if (openId === id) setOpenId(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          A saved audience and template. Running one drafts to the approval queue — it never sends without review.
        </p>
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="size-4" /> New campaign
          </CardTitle>
          <CardDescription>Leave a filter blank to include everyone.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chennai resellers Q1" />
            </div>
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="any" />
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="any" />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="any" />
            </div>
            <div className="space-y-1.5">
              <Label>Template</Label>
              <Select value={templateId} onValueChange={(v) => setTemplateId(v ?? '')}>
                <SelectTrigger>
                  <SelectValue placeholder="Active template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button disabled={creating || !name.trim()} onClick={create}>
            {creating ? 'Creating…' : 'Create campaign'}
          </Button>
        </CardContent>
      </Card>

      {campaigns === null ? (
        <Skeleton className="h-32 w-full" />
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No campaigns yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardContent className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {Object.entries(c.segmentFilter ?? {})
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ') || 'All eligible dealers'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{c.status}</Badge>
                    <Button size="sm" variant="outline" onClick={() => open(c.id)}>
                      <Users className="size-3.5" /> Preview
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => run(c.id)}>
                      <Play className="size-3.5" /> Run
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => remove(c.id)} title="Delete">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {openId === c.id && (
                  <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
                    {preview === null ? (
                      <Skeleton className="h-12 w-full" />
                    ) : (
                      <>
                        <p className="font-medium">
                          {preview.total.toLocaleString()} dealer{preview.total === 1 ? '' : 's'} would be contacted
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {preview.sample.map((d) => d.businessName).join(', ')}
                          {preview.total > preview.sample.length ? ' …' : ''}
                        </p>
                      </>
                    )}
                    {stats && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <Badge variant="secondary">{stats.drafted} drafted</Badge>
                        {Object.entries(stats.byStatus).map(([s, n]) => (
                          <Badge key={s} variant="outline">
                            {s}: {n}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
