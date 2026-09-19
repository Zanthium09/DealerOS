'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { fileToBase64 } from '@/lib/files';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { CircleDollarSign, Package, RefreshCw, ShoppingCart } from 'lucide-react';

type Kind = 'orders' | 'payments' | 'products';

type Batch = {
  id: string;
  kind: 'ORDERS' | 'PAYMENTS' | 'PRODUCTS';
  filename: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  unmatchedCount: number;
  invalidCount: number;
  errors: { row: number; reason: string }[];
  startedAt: string;
};

type Freshness = Record<Kind, string | null>;

const KINDS: { kind: Kind; label: string; icon: typeof ShoppingCart; hint: string }[] = [
  { kind: 'orders', label: 'Orders', icon: ShoppingCart, hint: 'Invoice / order no, date, party, and either an amount or qty × rate. Re-importing the same invoice number updates it, never duplicates it.' },
  { kind: 'payments', label: 'Payments & dues', icon: CircleDollarSign, hint: 'Invoice no, party, amount, due date, and paid amount / date. Drives the ageing buckets.' },
  { kind: 'products', label: 'Products', icon: Package, hint: 'SKU, name, price, optional category.' },
];

function ago(iso: string | null): string {
  if (!iso) return 'never synced';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export default function SyncPage() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(() => {
    apiFetch<Batch[]>('/sync/batches').then(setBatches).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load'));
    apiFetch<Freshness>('/sync/freshness').then(setFresh).catch(() => {});
  }, []);

  useEffect(load, [load]);

  // Imports run in the background — poll while one is going.
  const running = batches?.some((b) => b.status === 'RUNNING') ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [running, load]);

  async function upload(kind: Kind, file: File) {
    setBusy(kind);
    setError(null);
    try {
      await apiFetch(`/sync/imports/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentBase64: await fileToBase64(file) }),
      });
      toast.success(`Importing ${file.name}…`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(null);
      const el = inputs.current[kind];
      if (el) el.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Data sync</h1>
          <p className="text-sm text-muted-foreground">
            Import order and payment exports from your accounting software. Everything that depends on them — dormancy, collections, schemes — reads
            what you import here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="grid gap-3 md:grid-cols-3">
        {KINDS.map(({ kind, label, icon: Icon, hint }) => (
          <Card key={kind}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="size-4" /> {label}
              </CardTitle>
              <CardDescription>{hint}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Last synced: <span className="font-medium text-foreground">{fresh ? ago(fresh[kind]) : '…'}</span>
              </p>
              <input
                ref={(el) => {
                  inputs.current[kind] = el;
                }}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && upload(kind, e.target.files[0])}
              />
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => inputs.current[kind]?.click()}>
                {busy === kind ? 'Uploading…' : `Import ${label.toLowerCase()}`}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent imports</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {batches === null ? (
            <Skeleton className="h-16 w-full" />
          ) : batches.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No imports yet.</p>
          ) : (
            batches.map((b) => (
              <div key={b.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{b.kind.toLowerCase()}</span> <span className="text-muted-foreground">{b.filename}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        b.status === 'COMPLETED' ? 'bg-green-100 text-green-800' : b.status === 'FAILED' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'
                      }
                    >
                      {b.status}
                    </Badge>
                  </div>
                </div>
                {b.status !== 'RUNNING' && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {b.rowCount} rows · {b.createdCount} new · {b.updatedCount} updated
                    {b.unmatchedCount > 0 && <span className="font-medium text-amber-700"> · {b.unmatchedCount} no matching dealer</span>}
                    {b.invalidCount > 0 && <span className="font-medium text-red-700"> · {b.invalidCount} unreadable</span>}
                  </p>
                )}
                {b.errors.length > 0 && (
                  <>
                    <button className="mt-1 text-xs underline" onClick={() => setOpen(open === b.id ? null : b.id)}>
                      {open === b.id ? 'Hide' : 'Show'} skipped rows
                    </button>
                    {open === b.id && (
                      <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                        {b.errors.map((e, i) => (
                          <li key={i}>
                            Row {e.row}: {e.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
