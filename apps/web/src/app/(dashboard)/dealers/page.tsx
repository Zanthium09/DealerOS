'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';

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

  const fileInput = useRef<HTMLInputElement>(null);
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

  async function runOutreach() {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const result = await apiFetch<RunResult>('/outreach-email/run', { method: 'POST' });
      setRunResult(result);
      load();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
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
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <div className="space-y-6">
      {hasVerifiedIdentity === false && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No verified sending identity yet — cold outreach emails cannot be sent until you add and verify one.{' '}
          <Link href="/settings" className="font-medium underline">
            Go to Settings
          </Link>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dealers</h1>
        <button
          onClick={runOutreach}
          disabled={running}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {running ? 'Running…' : 'Run Cold Outreach'}
        </button>
      </div>

      {runError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{runError}</p>}
      {runResult && (
        <div className="rounded border bg-white px-4 py-3 text-sm">
          <p className="font-medium">
            Drafted {runResult.drafted}, auto-sent {runResult.sent}, skipped {runResult.skipped.length}.
          </p>
          {runResult.skipped.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-neutral-600">
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
        </div>
      )}

      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Import dealer list (CSV/XLSX)</h2>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded border px-2 py-1.5 text-sm"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={onFileChosen}
            className="text-sm"
            disabled={importBusy}
          />
        </div>

        {importError && <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{importError}</p>}

        {preview && (
          <div className="mt-4 space-y-3 rounded border bg-neutral-50 p-3 text-sm">
            <p>
              {preview.rowCount} row(s) found. Suggested column mapping:
            </p>
            <ul className="list-inside list-disc text-neutral-700">
              {Object.entries(preview.suggestedMapping).map(([field, col]) => (
                <li key={field}>
                  <span className="font-medium">{field}</span> ← {Array.isArray(col) ? col.join(', ') : col}
                </li>
              ))}
            </ul>
            {!preview.suggestedMapping.businessName && (
              <p className="text-red-700">No business name column detected — import will fail.</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={confirmImport}
                disabled={importBusy || !preview.suggestedMapping.businessName}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {importBusy ? 'Importing…' : 'Confirm & Import'}
              </button>
              <button onClick={cancelImport} className="rounded border px-3 py-1.5 text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}

        {importResult && (
          <p className="mt-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            Created {importResult.createdCount}, duplicates {importResult.duplicateCount}, invalid{' '}
            {importResult.invalidCount}, flagged for review {importResult.flaggedCount}.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-600">Pipeline stage:</label>
        <select className="rounded border px-2 py-1.5 text-sm" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loadError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b bg-neutral-50 text-left text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Business</th>
              <th className="px-4 py-2 font-medium">City</th>
              <th className="px-4 py-2 font-medium">Stage</th>
              <th className="px-4 py-2 font-medium">Primary email</th>
            </tr>
          </thead>
          <tbody>
            {dealers === null ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={4}>
                  Loading…
                </td>
              </tr>
            ) : dealers.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={4}>
                  No dealers yet — import a list above to get started.
                </td>
              </tr>
            ) : (
              dealers.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="px-4 py-2">{d.businessName}</td>
                  <td className="px-4 py-2">{[d.city, d.state].filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-4 py-2">
                    <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium">{d.pipelineStage}</span>
                  </td>
                  <td className="px-4 py-2">{d.emails.find((e) => e.isPrimary)?.address ?? d.emails[0]?.address ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
