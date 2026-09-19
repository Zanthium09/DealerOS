'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { fileToBase64 } from '@/lib/files';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Check, FileUp, Globe, PauseCircle, PlayCircle, Radar, X } from 'lucide-react';

type Run = {
  id: string;
  method: string;
  query: Record<string, string>;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REFUSED';
  refusalReason: string | null;
  resultCount: number;
  error: string | null;
  startedAt: string;
};

type Candidate = {
  id: string;
  businessName: string;
  contactPersonName: string | null;
  rawPhones: string[];
  rawEmails: string[];
  city: string | null;
  state: string | null;
  category: string | null;
  sourceUrl: string;
  dedupeStatus: 'UNIQUE' | 'POSSIBLE_DUPLICATE' | 'CONFIRMED_DUPLICATE';
  matchScore: number | null;
  matchedDealer: { id: string; businessName: string; city: string | null } | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DUPLICATE';
};

const RUN_TONE: Record<Run['status'], string> = {
  RUNNING: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  REFUSED: 'bg-amber-100 text-amber-800',
};

const METHOD_LABEL: Record<string, string> = {
  URL_EXTRACT: 'Web page',
  FILE_EXTRACT: 'File',
  PLACES_API: 'Google Places',
  REGISTRY: 'GST registry',
};

export default function LeadsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    apiFetch<Run[]>('/lead-discovery/runs').then(setRuns).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load runs'));
    apiFetch<Candidate[]>('/lead-discovery/candidates?status=PENDING').then(setCandidates).catch(() => setCandidates([]));
    apiFetch<{ paused: boolean }>('/lead-discovery/status').then((s) => setPaused(s.paused)).catch(() => {});
  }, []);

  useEffect(load, [load]);

  // Runs execute in the background; keep polling while any is still going.
  const anyRunning = runs?.some((r) => r.status === 'RUNNING') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  async function startUrl() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const run = await apiFetch<Run>('/lead-discovery/runs/url', { method: 'POST', body: JSON.stringify({ url }) });
      if (run.status === 'REFUSED') toast.warning(run.error ?? 'That site does not allow automated access.');
      else toast.success('Reading the page…');
      setUrl('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  }

  async function startFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/lead-discovery/runs/file', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentBase64: await fileToBase64(file) }),
      });
      toast.success(`Reading ${file.name}…`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function decide(ids: string[], decision: 'approve' | 'reject') {
    if (ids.length === 0) return;
    setDeciding(true);
    try {
      const res = await apiFetch<{ ok: number; failed: number; results: { id: string; ok: boolean; error?: string }[] }>(
        '/lead-discovery/candidates/decide',
        { method: 'POST', body: JSON.stringify({ ids, decision }) },
      );
      if (res.failed) toast.warning(`${res.ok} done, ${res.failed} refused — ${res.results.find((r) => !r.ok)?.error ?? ''}`);
      else toast.success(decision === 'approve' ? `${res.ok} added to Dealers` : `${res.ok} rejected`);
      setSelected(new Set());
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setDeciding(false);
    }
  }

  async function togglePause() {
    try {
      const s = await apiFetch<{ paused: boolean }>('/lead-discovery/pause', { method: 'POST', body: JSON.stringify({ paused: !paused }) });
      setPaused(s.paused);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed');
    }
  }

  const pending = candidates ?? [];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Lead discovery</h1>
          <p className="text-sm text-muted-foreground">
            Find businesses that aren&apos;t in your list yet. Nothing becomes a dealer until you approve it.
          </p>
        </div>
        <Button variant={paused ? 'default' : 'outline'} size="sm" onClick={togglePause}>
          {paused ? (
            <>
              <PlayCircle className="size-4" /> Resume discovery
            </>
          ) : (
            <>
              <PauseCircle className="size-4" /> Pause discovery
            </>
          )}
        </Button>
      </div>

      {paused && (
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">Discovery is paused — new runs are refused until you resume.</p>
      )}
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="size-4" /> From a web page
            </CardTitle>
            <CardDescription>
              A directory, trade-fair list or association page. Sites that forbid automated access (IndiaMART, JustDial, TradeIndia)
              are refused — open those yourself and add dealers by hand.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" onKeyDown={(e) => e.key === 'Enter' && startUrl()} />
            <Button disabled={busy || !url.trim() || paused} onClick={startUrl}>
              Read page
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileUp className="size-4" /> From a file
            </CardTitle>
            <CardDescription>
              CSV or Excel (read as-is), or a .txt / .html file (read by AI, every value checked against your text). PDFs need exporting first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xlsx,.xls,.txt,.md,.html,.htm"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && startFile(e.target.files[0])}
            />
            <Button variant="outline" disabled={busy || paused} onClick={() => fileInput.current?.click()}>
              <FileUp className="size-4" /> Choose file
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radar className="size-4" /> Waiting for review
            {candidates !== null && <Badge variant="secondary">{pending.length}</Badge>}
          </CardTitle>
          {selected.size > 0 && (
            <div className="flex gap-2">
              <Button size="sm" disabled={deciding} onClick={() => decide([...selected], 'approve')}>
                <Check className="size-3.5" /> Approve {selected.size}
              </Button>
              <Button size="sm" variant="outline" disabled={deciding} onClick={() => decide([...selected], 'reject')}>
                <X className="size-3.5" /> Reject {selected.size}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {candidates === null ? (
            <Skeleton className="h-24 w-full" />
          ) : pending.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing waiting. Read a page or file above to find leads.</p>
          ) : (
            pending.map((c) => (
              <div key={c.id} className="flex items-start gap-3 rounded-lg border p-3">
                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{c.businessName}</p>
                    {c.dedupeStatus === 'POSSIBLE_DUPLICATE' && (
                      <Badge className="bg-amber-100 text-amber-800">
                        Possible duplicate{c.matchedDealer ? ` of ${c.matchedDealer.businessName}` : ''}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[c.city, c.state, c.category].filter(Boolean).join(' · ') || 'No location'}
                    {c.contactPersonName ? ` · ${c.contactPersonName}` : ''}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[...c.rawPhones, ...c.rawEmails].join(' · ') || 'No contact details'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground/70">Source: {c.sourceUrl}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon-sm" variant="ghost" title="Approve" disabled={deciding} onClick={() => decide([c.id], 'approve')}>
                    <Check className="size-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" title="Reject" disabled={deciding} onClick={() => decide([c.id], 'reject')}>
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent runs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {runs === null ? (
            <Skeleton className="h-16 w-full" />
          ) : runs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            runs.slice(0, 15).map((r) => (
              <div key={r.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{METHOD_LABEL[r.method] ?? r.method}</span>{' '}
                    <span className="break-all text-muted-foreground">{r.query.url ?? r.query.filename ?? [r.query.city, r.query.category, r.query.gstin].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {r.status === 'COMPLETED' && <span className="text-xs text-muted-foreground">{r.resultCount} found</span>}
                    <Badge className={RUN_TONE[r.status]}>{r.status}</Badge>
                  </div>
                </div>
                {r.error && <p className="mt-1 text-xs text-muted-foreground">{r.error}</p>}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
