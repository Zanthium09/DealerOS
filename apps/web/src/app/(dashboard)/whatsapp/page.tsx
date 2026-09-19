'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { AlertTriangle, Check, Clock, MessageCircle, Send, X } from 'lucide-react';

type Settings = {
  paused: boolean;
  dailyLimit: number;
  configured: boolean;
  account: { phoneNumberId: string; wabaId: string; displayPhone: string | null; qualityEvent: string | null; messagingTier: string | null; broadcastsPausedByQuality: boolean } | null;
  rates: { MARKETING: number; UTILITY: number; AUTHENTICATION: number; asOf: string };
};

type Template = {
  id: string;
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  bodyText: string;
  paramKeys: string[];
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  rejectionReason: string | null;
};

type Conversation = {
  id: string;
  dealerId: string;
  state: string;
  needsHuman: boolean;
  humanReason: string | null;
  sessionOpen: boolean;
  sessionExpiresAt: string | null;
  lastInboundAt: string | null;
  dealer: { businessName: string; city: string | null; pipelineStage: string };
  lastMessage: { body: string; direction: 'INBOUND' | 'OUTBOUND' } | null;
};

type Msg = { id: string; direction: 'INBOUND' | 'OUTBOUND'; body: string; status: string; createdAt: string };
type Group = { dealerId: string; businessName: string; drafts: { id: string; draftText: string; lastSendError?: string | null }[] };
type Estimate = { eligibleDealers: number; willDraft: number; cost: { perMessage: number; total: number; asOf: string } };

const PARAM_KEYS = ['contactName', 'businessName', 'ourBusinessName', 'city', 'state'];
const STATUS_TONE: Record<Template['status'], string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  PAUSED: 'bg-amber-100 text-amber-800',
  DISABLED: 'bg-red-100 text-red-800',
};

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export default function WhatsAppPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(() => {
    apiFetch<Settings>('/outreach-whatsapp/settings').then(setSettings).catch((e) => setError(err(e, 'Failed to load')));
  }, []);
  useEffect(loadSettings, [loadSettings]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          The warm channel: only dealers who have already replied, clicked, messaged you or opted in. Approved templates start a conversation; free text
          works only in the 24 hours after they write to you.
        </p>
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {settings && !settings.configured && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          WhatsApp is not connected yet — no access token / phone number is set on the server, so nothing can be sent. Everything below works for
          preparing templates and reviewing.
        </p>
      )}
      {settings?.account?.broadcastsPausedByQuality && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4" /> Meta flagged this number ({settings.account.qualityEvent}). Marketing messages are paused; replies still work.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await apiFetch('/outreach-whatsapp/resume-broadcasts', { method: 'POST' });
              loadSettings();
            }}
          >
            I&apos;ve checked — resume marketing
          </Button>
        </div>
      )}
      {settings?.paused && <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">All WhatsApp sending is paused (Settings tab).</p>}

      <Tabs defaultValue="inbox">
        <TabsList>
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="campaign">Campaign & queue</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="mt-4">
          <Inbox />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <Templates />
        </TabsContent>
        <TabsContent value="campaign" className="mt-4">
          <Campaign />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          {settings ? <SettingsTab settings={settings} reload={loadSettings} /> : <Skeleton className="h-40 w-full" />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---- Inbox ---------------------------------------------------------------------

function Inbox() {
  const [rows, setRows] = useState<Conversation[] | null>(null);
  const [onlyHuman, setOnlyHuman] = useState(true);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [thread, setThread] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch<Conversation[]>(`/outreach-whatsapp/conversations${onlyHuman ? '?needsHuman=true' : ''}`).then(setRows).catch(() => setRows([]));
  }, [onlyHuman]);
  useEffect(load, [load]);
  useEffect(() => {
    apiFetch<Template[]>('/outreach-whatsapp/templates').then((t) => setTemplates(t.filter((x) => x.status === 'APPROVED'))).catch(() => {});
  }, []);

  async function select(c: Conversation) {
    setOpen(c);
    setThread(await apiFetch<Msg[]>(`/outreach-whatsapp/conversations/${c.dealerId}/messages`).catch(() => []));
  }

  async function reply() {
    if (!open || !text.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/outreach-whatsapp/conversations/${open.dealerId}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
      setText('');
      toast.success('Sent');
      await select(open);
      load();
    } catch (e) {
      toast.error(err(e, 'Could not send'));
    } finally {
      setBusy(false);
    }
  }

  async function queueTemplate(templateId: string) {
    if (!open) return;
    try {
      await apiFetch(`/outreach-whatsapp/dealers/${open.dealerId}/template`, { method: 'POST', body: JSON.stringify({ templateId }) });
      toast.success('Added to the approval queue (Campaign & queue tab)');
    } catch (e) {
      toast.error(err(e, 'Could not queue'));
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <Card className="h-fit">
        <CardHeader className="flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Conversations</CardTitle>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" className="accent-primary" checked={onlyHuman} onChange={(e) => setOnlyHuman(e.target.checked)} />
            Needs a person
          </label>
        </CardHeader>
        <CardContent className="space-y-1">
          {rows === null ? (
            <Skeleton className="h-20 w-full" />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              <MessageCircle className="mx-auto mb-2 size-6" />
              {onlyHuman ? 'Nothing waiting for you.' : 'No conversations yet.'}
            </p>
          ) : (
            rows.map((c) => (
              <button
                key={c.id}
                onClick={() => select(c)}
                className={`w-full rounded-lg border p-2 text-left text-sm transition-colors hover:bg-accent ${open?.id === c.id ? 'border-primary bg-accent' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{c.dealer.businessName}</span>
                  {c.needsHuman && <Badge className="bg-amber-100 text-amber-800">reply</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{c.lastMessage?.body}</p>
                {c.humanReason && <p className="truncate text-xs text-amber-700">{c.humanReason}</p>}
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{open ? open.dealer.businessName : 'Pick a conversation'}</CardTitle>
          {open && (
            <CardDescription className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              {open.sessionOpen
                ? `Window open until ${new Date(open.sessionExpiresAt!).toLocaleString()}`
                : 'The 24-hour window is closed — only an approved template can be sent'}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {!open ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Select a conversation on the left.</p>
          ) : (
            <>
              <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg bg-muted/40 p-3">
                {thread.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'OUTBOUND' ? 'justify-end' : ''}`}>
                    <div className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${m.direction === 'OUTBOUND' ? 'bg-primary text-primary-foreground' : 'bg-background border'}`}>
                      {m.body}
                      <p className="mt-1 text-[10px] opacity-70">{new Date(m.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
              {open.sessionOpen ? (
                <div className="flex gap-2">
                  <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
                  <Button disabled={busy || !text.trim()} onClick={reply}>
                    <Send className="size-4" />
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Send an approved template instead</Label>
                  <div className="flex flex-wrap gap-2">
                    {templates.length === 0 && <span className="text-sm text-muted-foreground">No approved templates yet.</span>}
                    {templates.map((t) => (
                      <Button key={t.id} size="sm" variant="outline" onClick={() => queueTemplate(t.id)}>
                        {t.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {open.needsHuman && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await apiFetch(`/outreach-whatsapp/conversations/${open.dealerId}/resolve`, { method: 'POST' });
                    load();
                  }}
                >
                  <Check className="size-3.5" /> Mark handled
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---- Templates -----------------------------------------------------------------

function Templates() {
  const [rows, setRows] = useState<Template[] | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Template['category']>('UTILITY');
  const [body, setBody] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<Template[]>('/outreach-whatsapp/templates').then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  function addParam(key: string) {
    const next = [...keys, key];
    setKeys(next);
    setBody((b) => `${b}{{${next.length}}}`);
  }

  async function create() {
    setFormError(null);
    try {
      await apiFetch('/outreach-whatsapp/templates', { method: 'POST', body: JSON.stringify({ name, category, bodyText: body, paramKeys: keys }) });
      setName('');
      setBody('');
      setKeys([]);
      load();
    } catch (e) {
      setFormError(err(e, 'Could not create'));
    }
  }

  async function act(id: string, path: string, method: 'POST' | 'DELETE' = 'POST') {
    setBusy(id);
    try {
      await apiFetch(`/outreach-whatsapp/templates/${id}${path}`, { method });
      load();
    } catch (e) {
      toast.error(err(e, 'Failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New template</CardTitle>
          <CardDescription>Meta reviews every template before it can be sent — usually within minutes to a day. Use the buttons to add a personalised field.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name (lowercase, digits, underscores)</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="dealer_followup" />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as Template['category'])}>
                <option value="UTILITY">Utility — about an existing relationship</option>
                <option value="MARKETING">Marketing — promotional (costs ~7× more)</option>
                <option value="AUTHENTICATION">Authentication</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Message</Label>
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hi {{1}}, thanks for getting in touch with us…" />
            <div className="flex flex-wrap gap-1">
              {PARAM_KEYS.map((k) => (
                <button key={k} type="button" onClick={() => addParam(k)} className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent">
                  + {k}
                </button>
              ))}
              {keys.length > 0 && <span className="text-xs text-muted-foreground">Fields in order: {keys.map((k, i) => `{{${i + 1}}}=${k}`).join(', ')}</span>}
            </div>
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <Button disabled={!name || !body} onClick={create}>
            Save draft
          </Button>
        </CardContent>
      </Card>

      {rows === null ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        rows.map((t) => (
          <Card key={t.id}>
            <CardContent className="space-y-2 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <Badge variant="outline">{t.category}</Badge>
                  <Badge className={STATUS_TONE[t.status]}>{t.status}</Badge>
                </div>
                <div className="flex gap-2">
                  {(t.status === 'DRAFT' || t.status === 'REJECTED') && (
                    <Button size="sm" disabled={busy === t.id} onClick={() => act(t.id, '/submit')}>
                      Submit to Meta
                    </Button>
                  )}
                  {t.status === 'PENDING' && (
                    <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => act(t.id, '/sync')}>
                      Check status
                    </Button>
                  )}
                  {(t.status === 'DRAFT' || t.status === 'REJECTED') && (
                    <Button size="icon-sm" variant="ghost" onClick={() => act(t.id, '', 'DELETE')} title="Delete">
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{t.bodyText}</p>
              {t.rejectionReason && <p className="text-xs text-destructive">Rejected: {t.rejectionReason}</p>}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ---- Campaign & queue ------------------------------------------------------------

function Campaign() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [max, setMax] = useState('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [queue, setQueue] = useState<Group[] | null>(null);
  const [failed, setFailed] = useState<{ id: string; lastSendError: string | null; dealer: { businessName: string } | null }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch<Template[]>('/outreach-whatsapp/templates').then((t) => setTemplates(t.filter((x) => x.status === 'APPROVED'))).catch(() => {});
    apiFetch<Group[]>('/outreach-whatsapp/queue').then(setQueue).catch(() => setQueue([]));
    apiFetch<typeof failed>('/outreach-whatsapp/failed').then(setFailed).catch(() => {});
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!templateId) return setEstimate(null);
    apiFetch<Estimate>(`/outreach-whatsapp/campaign/estimate?templateId=${templateId}${max ? `&maxDealers=${max}` : ''}`)
      .then(setEstimate)
      .catch(() => setEstimate(null));
  }, [templateId, max]);

  async function run() {
    setBusy(true);
    try {
      const res = await apiFetch<{ created: number }>('/outreach-whatsapp/campaign', {
        method: 'POST',
        body: JSON.stringify({ templateId, maxDealers: max ? Number(max) : undefined }),
      });
      toast.success(`${res.created} drafted — review them below`);
      load();
    } catch (e) {
      toast.error(err(e, 'Failed'));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, what: 'approve' | 'reject' | 'retry') {
    try {
      await apiFetch(`/outreach-whatsapp/drafts/${id}/${what}`, { method: 'POST' });
      if (what !== 'reject') toast.success('Sent');
    } catch (e) {
      toast.error(err(e, 'Failed'));
    }
    load();
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Send a template to warm dealers</CardTitle>
          <CardDescription>Only dealers who have engaged are included — that is enforced, not a filter you can widen. Messages go to the queue below first.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Approved template</Label>
              <select className="h-9 min-w-56 rounded-md border bg-background px-2 text-sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.category.toLowerCase()})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Limit (optional)</Label>
              <Input className="w-28" type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} />
            </div>
            <Button disabled={busy || !templateId || !estimate?.willDraft} onClick={run}>
              Draft {estimate?.willDraft ?? 0} to the queue
            </Button>
          </div>
          {estimate && (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
              {estimate.eligibleDealers} warm dealer{estimate.eligibleDealers === 1 ? '' : 's'} eligible · estimated cost{' '}
              <span className="font-medium">{inr(estimate.cost.total)}</span> ({inr(estimate.cost.perMessage)} each, India rates as of {estimate.cost.asOf} —
              an estimate, Meta&apos;s invoice is the truth)
            </p>
          )}
          {templates.length === 0 && <p className="text-sm text-muted-foreground">No approved templates yet — create and submit one in the Templates tab.</p>}
        </CardContent>
      </Card>

      {failed.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-destructive">{failed.length} approved but not sent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {failed.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{f.dealer?.businessName}</p>
                  <p className="truncate text-xs text-muted-foreground">{f.lastSendError ?? 'never sent'}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => decide(f.id, 'retry')}>
                  Retry
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Approval queue</CardTitle>
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
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{d.draftText}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" onClick={() => decide(d.id, 'approve')}>
                      <Check className="size-3.5" /> Approve & send
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
    </div>
  );
}

// ---- Settings ------------------------------------------------------------------

function SettingsTab({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState(settings.account?.phoneNumberId ?? '');
  const [wabaId, setWabaId] = useState(settings.account?.wabaId ?? '');
  const [limit, setLimit] = useState(String(settings.dailyLimit));
  const [msg, setMsg] = useState<string | null>(null);

  async function patch(body: object) {
    try {
      await apiFetch('/outreach-whatsapp/settings', { method: 'PATCH', body: JSON.stringify(body) });
      reload();
    } catch (e) {
      setMsg(err(e, 'Failed'));
    }
  }

  async function link() {
    setMsg(null);
    try {
      await apiFetch('/outreach-whatsapp/account', { method: 'POST', body: JSON.stringify({ phoneNumberId, wabaId }) });
      setMsg('Linked.');
      reload();
    } catch (e) {
      setMsg(err(e, 'Failed'));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">WhatsApp Business number</CardTitle>
          <CardDescription>
            From Meta Business Manager → WhatsApp → API setup. This is how incoming messages find your organization. The access token itself is set on the
            server, not here. Webhook URL to give Meta: <code className="rounded bg-muted px-1 text-xs">…/outreach-whatsapp/webhook</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Phone number ID</Label>
              <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>WhatsApp Business Account ID</Label>
              <Input value={wabaId} onChange={(e) => setWabaId(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!phoneNumberId || !wabaId} onClick={link}>
              Save
            </Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
          {settings.account?.messagingTier && <p className="text-xs text-muted-foreground">Meta messaging tier: {settings.account.messagingTier}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sending controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Pause all WhatsApp sending</p>
              <p className="text-xs text-muted-foreground">Immediate, no deploy. Incoming messages are still received.</p>
            </div>
            <Button variant={settings.paused ? 'default' : 'destructive'} onClick={() => patch({ paused: !settings.paused })}>
              {settings.paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label>Daily limit (0 = unlimited)</Label>
              <Input className="w-32" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => patch({ dailyLimit: Number(limit) })}>
              Save
            </Button>
            <p className="text-xs text-muted-foreground">Our ceiling, under Meta&apos;s own tiered limit.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Rates used for estimates (India, {settings.rates.asOf}): marketing {inr(settings.rates.MARKETING)}, utility {inr(settings.rates.UTILITY)}, per message.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
