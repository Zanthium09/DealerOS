'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Upload, SlidersHorizontal, Users } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { stageBadgeClass } from '@/lib/badge-styles';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Dealer = {
  id: string;
  businessName: string;
  contactPersonName: string | null;
  city: string | null;
  state: string | null;
  pipelineStage: string;
  source: string;
  emails: { address: string; isPrimary: boolean }[];
};

type RunResult = { drafted: number; sent: number; skipped: { dealerId: string; reason: string }[] };

type SegmentFilter = { pipelineStage?: string; city?: string; state?: string; businessCategory?: string; source?: string };

type ImportPreview = {
  batchId: string;
  headers: string[];
  suggestedMapping: Record<string, string | string[]>;
  sampleRows: Record<string, string>[];
  rowCount: number;
};

type ImportResult = { createdCount: number; duplicateCount: number; invalidCount: number; flaggedCount: number };

const STAGES = ['NEW', 'CONTACTED', 'INTERESTED', 'ONBOARDED', 'ACTIVE', 'DORMANT'];
const SOURCES = ['MANUAL', 'IMPORTED_LIST', 'TRADE_FAIR', 'INQUIRY', 'REFERRAL', 'DISCOVERED'];

// Base UI's <SelectValue> only renders the selected item's label (instead of the
// raw value) when the Root is given this `items` map — see @base-ui/react/select.
const STAGE_FILTER_ITEMS = { __all__: 'All', ...Object.fromEntries(STAGES.map((s) => [s, s])) };
const SOURCE_ITEMS = Object.fromEntries(SOURCES.map((s) => [s, s]));
const SOURCE_FILTER_ITEMS = { __any__: 'Any', ...SOURCE_ITEMS };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function DealersPage() {
  const [dealers, setDealers] = useState<Dealer[] | null>(null);
  const [stage, setStage] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [hasVerifiedIdentity, setHasVerifiedIdentity] = useState<boolean | null>(null);

  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [maxDealers, setMaxDealers] = useState('');
  const [forceReview, setForceReview] = useState(false);
  const [filterCity, setFilterCity] = useState('');
  const [filterState, setFilterState] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterSource, setFilterSource] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState('MANUAL');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    apiFetch<Dealer[]>(`/contacts${stage ? `?pipelineStage=${stage}` : ''}`)
      .then(setDealers)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load dealers'));
  }, [stage]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiFetch<{ verificationStatus: string }[]>('/outreach-email/sending-identities')
      .then((rows) => setHasVerifiedIdentity(rows.some((r) => r.verificationStatus === 'VERIFIED')))
      .catch(() => setHasVerifiedIdentity(false));
  }, []);

  function buildSegmentFilter(): SegmentFilter | undefined {
    const f: SegmentFilter = {};
    if (filterCity.trim()) f.city = filterCity.trim();
    if (filterState.trim()) f.state = filterState.trim();
    if (filterCategory.trim()) f.businessCategory = filterCategory.trim();
    if (filterSource) f.source = filterSource;
    return Object.keys(f).length > 0 ? f : undefined;
  }

  async function runOutreach(dealerIds?: string[]) {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const body: {
        maxDealers?: number;
        forceReview?: boolean;
        segmentFilter?: SegmentFilter & { dealerIds?: string[] };
      } = {};
      if (maxDealers.trim() && Number(maxDealers) > 0) body.maxDealers = Number(maxDealers);
      if (forceReview) body.forceReview = true;
      const segmentFilter = dealerIds ? { dealerIds } : buildSegmentFilter();
      if (segmentFilter) body.segmentFilter = segmentFilter;

      const result = await apiFetch<RunResult>('/outreach-email/run', { method: 'POST', body: JSON.stringify(body) });
      setRunResult(result);
      load();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    if (!dealers) return;
    setSelected((prev) => (prev.size === dealers.length ? new Set() : new Set(dealers.map((d) => d.id))));
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setImportError(null);
    setImportResult(null);
    setImportBusy(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const result = await apiFetch<ImportPreview>('/contacts/imports', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentBase64, source }),
      });
      setPreview(result);
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : 'Could not read file');
      setPreview(null);
    } finally {
      setImportBusy(false);
    }
  }

  async function confirmImport() {
    if (!preview || !pendingFile) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const contentBase64 = await fileToBase64(pendingFile);
      const result = await apiFetch<ImportResult>(`/contacts/imports/${preview.batchId}/run`, {
        method: 'POST',
        body: JSON.stringify({ contentBase64, mapping: preview.suggestedMapping }),
      });
      setImportResult(result);
      setPreview(null);
      setPendingFile(null);
      if (fileInput.current) fileInput.current.value = '';
      load();
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setImportBusy(false);
    }
  }

  function cancelImport() {
    setPreview(null);
    setPendingFile(null);
    setImportError(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function closeImportDialog() {
    setImportOpen(false);
    cancelImport();
    setImportResult(null);
  }

  return (
    <div className="space-y-6">
      {hasVerifiedIdentity === false && (
        <Alert variant="destructive">
          <AlertTitle>No verified sending identity</AlertTitle>
          <AlertDescription>
            Cold outreach emails cannot be sent until you add and verify one.{' '}
            <Link href="/settings">Go to Settings</Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Dealers</h1>
          <p className="text-sm text-muted-foreground">Prospect and dealer records across the pipeline.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> Import Dealers
          </Button>
          <Button variant={optionsOpen ? 'secondary' : 'outline'} onClick={() => setOptionsOpen((v) => !v)}>
            <SlidersHorizontal /> Options
          </Button>
          {selected.size > 0 && (
            <Button onClick={() => runOutreach(Array.from(selected))} disabled={running}>
              {running ? 'Running…' : `Send to Selected (${selected.size})`}
            </Button>
          )}
          <Button onClick={() => runOutreach()} disabled={running}>
            {running ? 'Running…' : 'Run Cold Outreach'}
          </Button>
        </div>
      </div>

      {optionsOpen && (
        <Card>
          <CardHeader>
            <CardTitle>Outreach options</CardTitle>
            <CardDescription>
              Applies to both send buttons above. Blank fields mean no filter / no limit. Selecting dealers via the
              checkboxes below ignores these segment filters and targets exactly those dealers instead.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="opt-limit">Limit this run to</Label>
                <Input
                  id="opt-limit"
                  type="number"
                  min={1}
                  placeholder="no limit"
                  value={maxDealers}
                  onChange={(e) => setMaxDealers(e.target.value)}
                  className="w-28"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-city">City</Label>
                <Input id="opt-city" value={filterCity} onChange={(e) => setFilterCity(e.target.value)} className="w-32" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-state">State</Label>
                <Input id="opt-state" value={filterState} onChange={(e) => setFilterState(e.target.value)} className="w-32" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="opt-category">Business category</Label>
                <Input
                  id="opt-category"
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="w-32"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select
                  items={SOURCE_FILTER_ITEMS}
                  value={filterSource || '__any__'}
                  onValueChange={(v) => setFilterSource(v === '__any__' ? '' : String(v))}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any</SelectItem>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 pb-1.5 text-sm">
                <input type="checkbox" checked={forceReview} onChange={(e) => setForceReview(e.target.checked)} />
                Send everything to the approval queue instead of auto-sending
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      {runError && (
        <Alert variant="destructive">
          <AlertDescription>{runError}</AlertDescription>
        </Alert>
      )}
      {runResult && (
        <Card>
          <CardContent className="text-sm">
            <p className="font-medium">
              Drafted {runResult.drafted}, auto-sent {runResult.sent}, skipped {runResult.skipped.length}.
            </p>
            {runResult.skipped.length > 0 && (
              <ul className="mt-2 list-inside list-disc text-muted-foreground">
                {runResult.skipped.map((s, i) => (
                  <li key={i}>
                    {s.dealerId}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
            {runResult.drafted - runResult.sent > 0 && (
              <p className="mt-2">
                <Link href="/queue" className="font-medium underline">
                  {runResult.drafted - runResult.sent} draft(s) need review in the Approval Queue.
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <Label>Pipeline stage</Label>
        <Select
          items={STAGE_FILTER_ITEMS}
          value={stage || '__all__'}
          onValueChange={(v) => setStage(v === '__all__' ? '' : String(v))}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All</SelectItem>
            {STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card className="py-0">
        {dealers === null ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : dealers.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Users className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No dealers yet</p>
              <p className="text-sm text-muted-foreground">Import a CSV or XLSX list to get started.</p>
            </div>
            <Button onClick={() => setImportOpen(true)}>
              <Upload /> Import Dealers
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={dealers.length > 0 && selected.size === dealers.length}
                    onChange={toggleSelectAllVisible}
                  />
                </TableHead>
                <TableHead>Business</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Primary email</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {dealers.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelected(d.id)} />
                  </TableCell>
                  <TableCell>
                    <Link href={`/dealers/${d.id}`} className="font-medium hover:underline">
                      {d.businessName}
                    </Link>
                    {d.contactPersonName && (
                      <span className="ml-2 text-xs text-muted-foreground">{d.contactPersonName}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {[d.city, d.state].filter(Boolean).join(', ') || '—'}
                  </TableCell>
                  <TableCell>
                    <Badge className={stageBadgeClass(d.pipelineStage)}>{d.pipelineStage}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.emails.find((e) => e.isPrimary)?.address ?? d.emails[0]?.address ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Link href={`/dealers/${d.id}`}>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={importOpen} onOpenChange={(open) => (open ? setImportOpen(true) : closeImportDialog())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import dealer list</DialogTitle>
            <DialogDescription>Upload a CSV or XLSX file. You&apos;ll confirm the column mapping before anything is created.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select items={SOURCE_ITEMS} value={source} onValueChange={(v) => setSource(String(v))}>
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>File</Label>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={onFileChosen}
                  className="text-sm"
                  disabled={importBusy}
                />
              </div>
            </div>

            {importError && (
              <Alert variant="destructive">
                <AlertDescription>{importError}</AlertDescription>
              </Alert>
            )}

            {preview && (
              <div className="space-y-3 rounded-lg border bg-muted/40 p-3 text-sm">
                <p>{preview.rowCount} row(s) found. Suggested column mapping:</p>
                <ul className="list-inside list-disc text-foreground/80">
                  {Object.entries(preview.suggestedMapping).map(([field, col]) => (
                    <li key={field}>
                      <span className="font-medium">{field}</span> ← {Array.isArray(col) ? col.join(', ') : col}
                    </li>
                  ))}
                </ul>
                {!preview.suggestedMapping.businessName && (
                  <p className="text-destructive">No business name column detected — import will fail.</p>
                )}
              </div>
            )}

            {importResult && (
              <Alert>
                <AlertDescription>
                  Created {importResult.createdCount}, duplicates {importResult.duplicateCount}, invalid{' '}
                  {importResult.invalidCount}, flagged for review {importResult.flaggedCount}.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeImportDialog}>
              {importResult ? 'Close' : 'Cancel'}
            </Button>
            {preview && (
              <Button onClick={confirmImport} disabled={importBusy || !preview.suggestedMapping.businessName}>
                {importBusy ? 'Importing…' : 'Confirm & Import'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
