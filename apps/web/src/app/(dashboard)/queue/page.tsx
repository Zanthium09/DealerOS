'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { IndianRupee, Inbox, Loader2 } from 'lucide-react';

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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState<{ done: number; total: number } | null>(null);

  function load() {
    setLoadError(null);
    apiFetch<DealerGroup[]>('/outreach-email/queue')
      .then((data) => {
        setGroups(data);
        setSelected((prev) => {
          const ids = new Set(data.flatMap((g) => g.drafts.map((d) => d.id)));
          return new Set([...prev].filter((id) => ids.has(id)));
        });
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load queue'));
  }

  useEffect(load, []);

  const allDraftIds = useMemo(() => (groups ?? []).flatMap((g) => g.drafts.map((d) => d.id)), [groups]);

  function removeDraft(draftId: string) {
    setGroups((prev) =>
      (prev ?? [])
        .map((g) => ({ ...g, drafts: g.drafts.filter((d) => d.id !== draftId) }))
        .filter((g) => g.drafts.length > 0),
    );
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(draftId);
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroupSelected(group: DealerGroup) {
    const ids = group.drafts.map((d) => d.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  function toggleAllSelected() {
    setSelected((prev) => (prev.size === allDraftIds.length ? new Set() : new Set(allDraftIds)));
  }

  async function approve(draftId: string) {
    setBusyId(draftId);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/approve`, { method: 'POST' });
      removeDraft(draftId);
      toast.success('Approved and sent.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Approve failed');
    } finally {
      setBusyId(null);
    }
  }

  async function editApprove(draftId: string) {
    setBusyId(draftId);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/edit-approve`, {
        method: 'POST',
        body: JSON.stringify({ draftText: editText }),
      });
      removeDraft(draftId);
      setEditingId(null);
      toast.success('Edited and sent.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Edit & approve failed');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(draftId: string) {
    setBusyId(draftId);
    try {
      await apiFetch(`/outreach-email/drafts/${draftId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason || undefined }),
      });
      removeDraft(draftId);
      setRejectingId(null);
      setRejectReason('');
      toast.success('Rejected.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Reject failed');
    } finally {
      setBusyId(null);
    }
  }

  async function bulkAction(kind: 'approve' | 'reject') {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkRunning({ done: 0, total: ids.length });
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await apiFetch(`/outreach-email/drafts/${id}/${kind === 'approve' ? 'approve' : 'reject'}`, {
          method: 'POST',
          ...(kind === 'reject' ? { body: JSON.stringify({}) } : {}),
        });
        removeDraft(id);
        ok += 1;
      } catch {
        failed += 1;
      }
      setBulkRunning((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
    }
    setBulkRunning(null);
    const verb = kind === 'approve' ? 'approved' : 'rejected';
    if (failed === 0) toast.success(`${ok} ${verb}.`);
    else toast.warning(`${ok} ${verb}, ${failed} failed.`);
  }

  const selectedCount = selected.size;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Approval Queue</h1>
          <p className="text-sm text-muted-foreground">Review AI-drafted emails before they go out.</p>
        </div>
        {groups !== null && groups.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selectedCount > 0 && selectedCount === allDraftIds.length}
                onChange={toggleAllSelected}
              />
              Select all ({allDraftIds.length})
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedCount === 0 || !!bulkRunning}
              onClick={() => bulkAction('approve')}
            >
              Approve selected {selectedCount > 0 ? `(${selectedCount})` : ''}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={selectedCount === 0 || !!bulkRunning}
              onClick={() => bulkAction('reject')}
            >
              Reject selected {selectedCount > 0 ? `(${selectedCount})` : ''}
            </Button>
          </div>
        )}
      </div>

      {bulkRunning && (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Processing {bulkRunning.done} / {bulkRunning.total}…
        </div>
      )}

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      {groups === null ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Inbox className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">Nothing waiting for review</p>
            <p className="text-sm text-muted-foreground">Drafts needing approval will show up here.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const groupIds = g.drafts.map((d) => d.id);
            const groupAllSelected = groupIds.every((id) => selected.has(id));
            return (
              <Card key={g.dealerId}>
                <CardHeader className="flex-row items-center justify-between border-b pb-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={groupAllSelected}
                      onChange={() => toggleGroupSelected(g)}
                    />
                    <CardTitle>{g.businessName}</CardTitle>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {g.drafts.length} draft{g.drafts.length === 1 ? '' : 's'}
                  </span>
                </CardHeader>
                <CardContent className="divide-y">
                  {g.drafts.map((d) => (
                    <div key={d.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0 accent-primary"
                          checked={selected.has(d.id)}
                          onChange={() => toggleSelected(d.id)}
                        />
                        <div className="flex-1 space-y-2">
                          {d.containsFinancialTerms && (
                            <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700">
                              <IndianRupee className="size-3" />
                              Contains financial terms
                            </Badge>
                          )}
                          {editingId === d.id ? (
                            <Textarea
                              rows={6}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              className="text-sm"
                            />
                          ) : (
                            <p className="whitespace-pre-wrap text-sm text-foreground">{d.draftText}</p>
                          )}

                          <div className="flex flex-wrap gap-2 pt-1">
                            {editingId === d.id ? (
                              <>
                                <Button size="sm" disabled={busyId === d.id} onClick={() => editApprove(d.id)}>
                                  Save & Send
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button size="sm" disabled={busyId === d.id} onClick={() => approve(d.id)}>
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busyId === d.id}
                                  onClick={() => {
                                    setEditingId(d.id);
                                    setEditText(d.draftText);
                                  }}
                                >
                                  Edit & Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busyId === d.id}
                                  onClick={() => setRejectingId(rejectingId === d.id ? null : d.id)}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                          </div>

                          {rejectingId === d.id && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <Input
                                placeholder="Reason (optional)"
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                className="max-w-xs"
                              />
                              <Button size="sm" variant="destructive" disabled={busyId === d.id} onClick={() => reject(d.id)}>
                                Confirm Reject
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
