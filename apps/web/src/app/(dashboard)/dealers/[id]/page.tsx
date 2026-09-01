'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Mail, Phone, MessageSquareText, ArrowUpRight, ArrowDownLeft, Save, Sparkles } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { stageBadgeClass, statusBadgeClass, consentBadgeClass } from '@/lib/badge-styles';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

type Dealer = {
  id: string;
  businessName: string;
  contactPersonName: string | null;
  notes: string | null;
  region: string | null;
  city: string | null;
  state: string | null;
  businessCategory: string | null;
  source: string;
  pipelineStage: string;
  assignedSalesmanId: string | null;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  emails: { id: string; address: string; verificationStatus: string; isPrimary: boolean }[];
  phones: { id: string; raw: string; e164: string | null; valid: boolean; isPrimary: boolean; isWhatsapp: boolean }[];
  consentLogs: { id: string; channel: string; state: string; source: string; createdAt: string }[];
  interactionEvents: {
    id: string;
    channel: string;
    direction: string;
    status: string;
    body: string | null;
    createdAt: string;
    providerMessageId: string | null;
  }[];
  assignedSalesman: { id: string; name: string; email: string } | null;
};

const STAGES = ['NEW', 'CONTACTED', 'INTERESTED', 'ONBOARDED', 'ACTIVE', 'DORMANT', 'REACTIVATED', 'OPTED_OUT', 'INVALID'];
// Base UI's <SelectValue> only shows the selected item's label when Root gets this `items` map.
const STAGE_ITEMS = Object.fromEntries(STAGES.map((s) => [s, s]));

function fmt(dt: string) {
  return new Date(dt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function emailVerificationClass(status: string) {
  if (status === 'VALID') return 'bg-green-100 text-green-800';
  if (status === 'INVALID' || status === 'RISKY') return 'bg-red-100 text-red-800';
  return 'bg-muted text-muted-foreground';
}

export default function DealerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [dealer, setDealer] = useState<Dealer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  const [savingStage, setSavingStage] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const [brief, setBrief] = useState('');
  const [draftingCustom, setDraftingCustom] = useState(false);
  const [customDraftError, setCustomDraftError] = useState<string | null>(null);
  const [customDraftDone, setCustomDraftDone] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    apiFetch<Dealer>(`/contacts/${id}`)
      .then((d) => {
        setDealer(d);
        setNotesDraft(d.notes ?? '');
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load dealer'));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveNotes() {
    if (!dealer) return;
    setSavingNotes(true);
    setNotesSaved(false);
    try {
      const updated = await apiFetch<Dealer>(`/contacts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: notesDraft }),
      });
      setDealer((prev) => (prev ? { ...prev, notes: updated.notes } : prev));
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2500);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not save notes');
    } finally {
      setSavingNotes(false);
    }
  }

  async function changeStage(next: string | null) {
    if (!dealer || !next || next === dealer.pipelineStage) return;
    setSavingStage(true);
    setStageError(null);
    const prevStage = dealer.pipelineStage;
    setDealer((prev) => (prev ? { ...prev, pipelineStage: next } : prev));
    try {
      await apiFetch(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ pipelineStage: next }) });
    } catch (err) {
      setDealer((prev) => (prev ? { ...prev, pipelineStage: prevStage } : prev));
      setStageError(err instanceof ApiError ? err.message : 'Could not change stage');
    } finally {
      setSavingStage(false);
    }
  }

  async function writeCustomDraft() {
    if (!dealer || !brief.trim()) return;
    setDraftingCustom(true);
    setCustomDraftError(null);
    setCustomDraftDone(false);
    try {
      await apiFetch('/outreach-email/custom-draft', {
        method: 'POST',
        body: JSON.stringify({ dealerId: dealer.id, brief }),
      });
      setBrief('');
      setCustomDraftDone(true);
      setTimeout(() => setCustomDraftDone(false), 4000);
    } catch (err) {
      // The backend's message is the useful part here — e.g. "contains a digit...
      // rephrase the instructions to describe the offer without stating a figure" —
      // show it as-is rather than a generic failure.
      setCustomDraftError(err instanceof ApiError ? err.message : 'Could not generate a draft');
    } finally {
      setDraftingCustom(false);
    }
  }

  if (loadError && !dealer) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  if (!dealer) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/dealers" />}>Dealers</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{dealer.businessName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold">{dealer.businessName}</h1>
              {dealer.contactPersonName && (
                <p className="text-sm text-muted-foreground">Contact: {dealer.contactPersonName}</p>
              )}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <Badge variant="outline">{dealer.source}</Badge>
                {[dealer.city, dealer.state, dealer.businessCategory].filter(Boolean).map((v) => (
                  <Badge key={v} variant="secondary">
                    {v}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Pipeline stage</p>
              <Select items={STAGE_ITEMS} value={dealer.pipelineStage} onValueChange={changeStage} disabled={savingStage}>
                <SelectTrigger className={stageBadgeClass(dealer.pipelineStage) + ' border-transparent font-medium'}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAGES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {stageError && <p className="text-xs text-destructive">{stageError}</p>}
            </div>
          </div>
          {dealer.assignedSalesman && (
            <p className="mt-3 text-sm text-muted-foreground">
              Assigned to <span className="font-medium text-foreground">{dealer.assignedSalesman.name}</span> (
              {dealer.assignedSalesman.email})
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Contact info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {dealer.emails.length === 0 && dealer.phones.length === 0 && (
              <p className="text-sm text-muted-foreground">No contact details on file.</p>
            )}
            {dealer.emails.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 truncate">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{e.address}</span>
                  {e.isPrimary && (
                    <Badge variant="secondary" className="shrink-0">
                      Primary
                    </Badge>
                  )}
                </span>
                <Badge className={emailVerificationClass(e.verificationStatus) + ' shrink-0'}>
                  {e.verificationStatus}
                </Badge>
              </div>
            ))}
            {dealer.phones.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 truncate">
                  <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.e164 ?? p.raw}</span>
                  {p.isPrimary && (
                    <Badge variant="secondary" className="shrink-0">
                      Primary
                    </Badge>
                  )}
                  {p.isWhatsapp && (
                    <Badge variant="secondary" className="shrink-0">
                      WhatsApp
                    </Badge>
                  )}
                </span>
                <Badge className={(p.valid ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800') + ' shrink-0'}>
                  {p.valid ? 'Valid' : 'Invalid'}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Consent history</CardTitle>
            <CardDescription>Most recent 20 entries — per channel, most recent row wins.</CardDescription>
          </CardHeader>
          <CardContent>
            {dealer.consentLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No consent recorded yet.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dealer.consentLogs.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>{c.channel}</TableCell>
                        <TableCell>
                          <Badge className={consentBadgeClass(c.state)}>{c.state}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{c.source}</TableCell>
                        <TableCell className="text-muted-foreground">{fmt(c.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
          <CardDescription>Internal notes — not sent to the dealer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            rows={4}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="e.g. Called twice, wants a discount…"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveNotes} disabled={savingNotes || notesDraft === (dealer.notes ?? '')}>
              <Save /> {savingNotes ? 'Saving…' : 'Save notes'}
            </Button>
            {notesSaved && <span className="text-xs text-muted-foreground">Saved.</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Write with AI
          </CardTitle>
          <CardDescription>
            Describe what this email should say — tone, occasion, what to mention. The AI writes it, but it
            can never state a number: no price, discount, date or quantity, in digits or words. Ask for the
            offer without a figure, then add the real number yourself when you review it below — every AI
            draft lands in the Approval Queue, it never sends on its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. Check in after two quiet months, warm and personal tone, mention we've valued working with them."
          />
          {customDraftError && (
            <Alert variant="destructive">
              <AlertDescription>{customDraftError}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={writeCustomDraft} disabled={draftingCustom || !brief.trim()}>
              <Sparkles /> {draftingCustom ? 'Writing…' : 'Write draft'}
            </Button>
            {customDraftDone && (
              <span className="text-xs text-muted-foreground">
                Draft created —{' '}
                <Link href="/queue" className="underline">
                  review it in the Approval Queue
                </Link>
                .
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Interaction history</CardTitle>
          <CardDescription>
            Every touch across every channel — the most recent 50. This is exactly what was sent or received.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dealer.interactionEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No interactions recorded yet.</p>
          ) : (
            <div className="divide-y">
              {dealer.interactionEvents.map((ev) => {
                const expanded = expandedEventId === ev.id;
                const preview = ev.body ? ev.body.replace(/\s+/g, ' ').trim() : null;
                const isLong = (preview?.length ?? 0) > 140;
                return (
                  <div key={ev.id} className="space-y-1.5 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {ev.direction === 'OUTBOUND' ? (
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowDownLeft className="h-3.5 w-3.5" />
                      )}
                      <span className="font-medium text-foreground">{ev.channel}</span>
                      <span>{ev.direction === 'OUTBOUND' ? 'sent' : 'received'}</span>
                      <Badge className={statusBadgeClass(ev.status)}>{ev.status}</Badge>
                      <span className="ml-auto">{fmt(ev.createdAt)}</span>
                    </div>
                    {preview ? (
                      <button
                        type="button"
                        onClick={() => isLong && setExpandedEventId(expanded ? null : ev.id)}
                        className={
                          'flex items-start gap-1.5 text-left text-sm text-foreground/90 ' +
                          (isLong ? 'cursor-pointer' : 'cursor-default')
                        }
                      >
                        <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className={expanded ? 'whitespace-pre-wrap' : 'truncate'}>
                          {expanded ? preview : isLong ? preview.slice(0, 140) + '…' : preview}
                        </span>
                      </button>
                    ) : (
                      <p className="pl-5 text-sm italic text-muted-foreground">No message body recorded.</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
