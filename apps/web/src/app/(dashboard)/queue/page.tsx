'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';

type Draft = {
  id: string;
  draftText: string;
  containsFinancialTerms: boolean;
  requiresApproval: boolean;
  status: string;
  createdAt: string;
};

type DealerGroup = { dealerId: string; businessName: string; drafts: Draft[] };

export default function QueuePage() {
  const [groups, setGroups] = useState<DealerGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  function load() {
    setLoadError(null);
    apiFetch<DealerGroup[]>('/outreach-email/queue')
      .then(setGroups)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load queue'));
  }

  useEffect(load, []);

  function removeDraft(draftId: string) {
    setGroups((prev) =>
      (prev ?? [])
        .map((g) => ({ ...g, drafts: g.drafts.filter((d) => d.id !== draftId) }))
        .filter((g) => g.drafts.length > 0),
    );
  }

  async function approve(draftId: string) {
    setBusyId(draftId);
    setMessage(null);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/approve`, { method: 'POST' });
      removeDraft(draftId);
      setMessage({ kind: 'ok', text: 'Approved and sent.' });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof ApiError ? err.message : 'Approve failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function editApprove(draftId: string) {
    setBusyId(draftId);
    setMessage(null);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/edit-approve`, {
        method: 'POST',
        body: JSON.stringify({ draftText: editText }),
      });
      removeDraft(draftId);
      setEditingId(null);
      setMessage({ kind: 'ok', text: 'Edited and sent.' });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof ApiError ? err.message : 'Edit & approve failed' });
    } finally {
      setBusyId(null);
    }
  }

  async function reject(draftId: string) {
    setBusyId(draftId);
    setMessage(null);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason || undefined }),
      });
      removeDraft(draftId);
      setRejectingId(null);
      setRejectReason('');
      setMessage({ kind: 'ok', text: 'Rejected.' });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof ApiError ? err.message : 'Reject failed' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Approval Queue</h1>

      {message && (
        <p className={`rounded px-3 py-2 text-sm ${message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>
          {message.text}
        </p>
      )}
      {loadError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      {groups === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="rounded border bg-white px-4 py-6 text-center text-sm text-neutral-500">
          Nothing waiting for review.
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.dealerId} className="rounded border bg-white">
              <h2 className="border-b px-4 py-2 text-sm font-semibold">{g.businessName}</h2>
              <div className="divide-y">
                {g.drafts.map((d) => (
                  <div key={d.id} className="space-y-2 px-4 py-3">
                    {d.containsFinancialTerms && (
                      <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Contains financial terms
                      </span>
                    )}
                    {editingId === d.id ? (
                      <textarea
                        className="w-full rounded border px-3 py-2 text-sm"
                        rows={6}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap text-sm text-neutral-800">{d.draftText}</p>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      {editingId === d.id ? (
                        <>
                          <button
                            onClick={() => editApprove(d.id)}
                            disabled={busyId === d.id}
                            className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Save & Send
                          </button>
                          <button onClick={() => setEditingId(null)} className="rounded border px-3 py-1.5 text-xs">
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => approve(d.id)}
                            disabled={busyId === d.id}
                            className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(d.id);
                              setEditText(d.draftText);
                            }}
                            disabled={busyId === d.id}
                            className="rounded border px-3 py-1.5 text-xs"
                          >
                            Edit & Approve
                          </button>
                          <button
                            onClick={() => setRejectingId(rejectingId === d.id ? null : d.id)}
                            disabled={busyId === d.id}
                            className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700"
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>

                    {rejectingId === d.id && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <input
                          className="flex-1 rounded border px-2 py-1 text-xs"
                          placeholder="Reason (optional)"
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                        />
                        <button
                          onClick={() => reject(d.id)}
                          disabled={busyId === d.id}
                          className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        >
                          Confirm Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
