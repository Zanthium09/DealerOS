'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { TriangleAlert, Trash2, Pencil, Mail } from 'lucide-react';
import { SendingControlsSection } from './sending-controls';

type SendingIdentity = {
  id: string;
  domain: string;
  provider: string;
  verificationStatus: string;
  currentDailyLimit: number;
  warmupStartedAt: string | null;
};

type Template = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  useAi: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type SuppressionRow = {
  id: string;
  email: string | null;
  phoneE164: string | null;
  reason: string;
  createdAt: string;
};

const PLACEHOLDERS = ['{{contactName}}', '{{ourBusinessName}}', '{{businessName}}', '{{city}}', '{{state}}', '{{region}}', '{{businessCategory}}'];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Sending limits, identities, email wording, and the suppression list.
        </p>
      </div>
      <Tabs defaultValue="sending">
        <TabsList>
          <TabsTrigger value="sending">Sending Controls</TabsTrigger>
          <TabsTrigger value="identities">Sending Identities</TabsTrigger>
          <TabsTrigger value="templates">Email Templates</TabsTrigger>
          <TabsTrigger value="suppressions">Suppression List</TabsTrigger>
        </TabsList>
        <TabsContent value="sending" className="mt-4">
          <SendingControlsSection />
        </TabsContent>
        <TabsContent value="identities" className="mt-4">
          <IdentitiesSection />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesSection />
        </TabsContent>
        <TabsContent value="suppressions" className="mt-4">
          <SuppressionsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sending identities
// ---------------------------------------------------------------------------

function IdentitiesSection() {
  const [identities, setIdentities] = useState<SendingIdentity[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [provider, setProvider] = useState('resend');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [savingLimitId, setSavingLimitId] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    apiFetch<SendingIdentity[]>('/outreach-email/sending-identities')
      .then(setIdentities)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load'));
  }

  useEffect(load, []);

  async function addIdentity(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await apiFetch('/outreach-email/sending-identities', {
        method: 'POST',
        body: JSON.stringify({ domain, provider }),
      });
      setDomain('');
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not add sending identity');
    } finally {
      setCreating(false);
    }
  }

  async function markVerified(id: string) {
    setVerifyingId(id);
    try {
      await apiFetch(`/outreach-email/sending-identities/${id}/verify`, { method: 'POST' });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not verify');
    } finally {
      setVerifyingId(null);
    }
  }

  async function saveLimit(id: string) {
    const raw = limitDrafts[id];
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 1) {
      toast.error('Daily limit must be a positive number');
      return;
    }
    setSavingLimitId(id);
    try {
      await apiFetch(`/outreach-email/sending-identities/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ currentDailyLimit: Math.floor(value) }),
      });
      setLimitDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update daily limit');
    } finally {
      setSavingLimitId(null);
    }
  }

  const hasVerified = identities?.some((i) => i.verificationStatus === 'VERIFIED') ?? false;

  return (
    <div className="space-y-4">
      {!hasVerified && identities !== null && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            Cold outreach emails cannot be sent until at least one sending identity is verified below.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add sending identity</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={addIdentity} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Domain</Label>
              <Input placeholder="mail-yourorg.in" value={domain} onChange={(e) => setDomain(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label>Provider</Label>
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
            </div>
            <Button type="submit" disabled={creating}>
              {creating ? 'Adding…' : 'Add Sending Identity'}
            </Button>
          </form>
          {createError && <p className="mt-2 text-sm text-destructive">{createError}</p>}
        </CardContent>
      </Card>

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      <Card>
        {identities === null ? (
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        ) : identities.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No sending identities yet — add one above.
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Daily limit</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identities.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.domain}</TableCell>
                  <TableCell>{i.provider}</TableCell>
                  <TableCell>
                    <Badge variant={i.verificationStatus === 'VERIFIED' ? 'default' : 'secondary'}>
                      {i.verificationStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        className="w-20"
                        placeholder={String(i.currentDailyLimit)}
                        value={limitDrafts[i.id] ?? ''}
                        onChange={(e) => setLimitDrafts((prev) => ({ ...prev, [i.id]: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingLimitId === i.id || !limitDrafts[i.id]}
                        onClick={() => saveLimit(i.id)}
                      >
                        {savingLimitId === i.id ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    {i.verificationStatus !== 'VERIFIED' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={verifyingId === i.id}
                        title="Mark verified only after you've confirmed the SPF/DKIM/DMARC DNS records with your email provider — this button does not check DNS itself."
                        onClick={() => markVerified(i.id)}
                      >
                        {verifyingId === i.id ? 'Marking…' : 'Mark Verified'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        &quot;Mark Verified&quot; is a manual stand-in — click it only after you have confirmed the SPF, DKIM and
        DMARC DNS records with your email provider.
      </p>
      <p className="text-xs text-muted-foreground">
        Daily limit is the ceiling once warmup has finished — while an identity is still ramping up, the lower
        warmup value applies regardless of what this is set to.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

function TemplatesSection() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function load() {
    setLoadError(null);
    apiFetch<Template[]>('/outreach-email/templates')
      .then(setTemplates)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load templates'));
  }

  useEffect(load, []);

  function startNew() {
    setEditingId('new');
    setName('');
    setSubject('');
    setBodyText('');
    setUseAi(true);
    setIsActive(true);
    setSaveError(null);
  }

  function startEdit(t: Template) {
    setEditingId(t.id);
    setName(t.name);
    setSubject(t.subject ?? '');
    setBodyText(t.bodyText);
    setUseAi(t.useAi ?? true);
    setIsActive(t.isActive);
    setSaveError(null);
  }

  function insertPlaceholder(token: string) {
    const el = textareaRef.current;
    if (!el) {
      setBodyText((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? bodyText.length;
    const end = el.selectionEnd ?? bodyText.length;
    const next = bodyText.slice(0, start) + token + bodyText.slice(end);
    setBodyText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      if (editingId === 'new') {
        await apiFetch('/outreach-email/templates', {
          method: 'POST',
          body: JSON.stringify({ name, subject, bodyText, useAi, isActive }),
        });
        toast.success('Template created.');
      } else if (editingId) {
        await apiFetch(`/outreach-email/templates/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, subject, bodyText, useAi, isActive }),
        });
        toast.success('Template updated.');
      }
      setEditingId(null);
      load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save template');
    } finally {
      setSaving(false);
    }
  }

  async function activate(t: Template) {
    try {
      await apiFetch(`/outreach-email/templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: true }),
      });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not activate template');
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/outreach-email/templates/${id}`, { method: 'DELETE' });
      toast.success('Template deleted.');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete template');
    }
  }

  async function resetToDefault() {
    setResetting(true);
    try {
      await apiFetch('/outreach-email/templates/reset-to-default', { method: 'POST' });
      toast.success('Reverted to the built-in default template.');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reset');
    } finally {
      setResetting(false);
    }
  }

  const anyActive = templates?.some((t) => t.isActive) ?? false;

  return (
    <div className="space-y-4">
      <Alert>
        <Mail />
        <AlertDescription>
          Write your own wording for the first cold email. A template can only use{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{'{{contactName}}'}</code>,{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{'{{ourBusinessName}}'}</code>, and{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{'{{businessName}}'}</code> — and no digits anywhere
          else. This keeps the AI from ever inventing a number in a message (amounts, discounts, quantities always
          come from real data, never free text).
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {anyActive ? 'One template is active at a time.' : 'No custom template active — the built-in default is used.'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={resetToDefault} disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset to Default'}
          </Button>
          <Button size="sm" onClick={startNew}>
            New Template
          </Button>
        </div>
      </div>

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      {editingId && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId === 'new' ? 'New template' : 'Edit template'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friendly opener" />
            </div>
            <div className="space-y-1">
              <Label>Subject line</Label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Dealer partnership — {{ourBusinessName}}"
              />
              <p className="text-xs text-muted-foreground">
                Every email used to share one fixed subject, which lands in spam. Give each template its own, and
                use placeholders to vary it per company.
              </p>
            </div>
            <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={useAi}
                onChange={(e) => setUseAi(e.target.checked)}
              />
              <span>
                <span className="font-medium">Let AI rewrite this for tone</span>
                <span className="block text-xs text-muted-foreground">
                  On: the AI rephrases your wording per dealer, and digits are not allowed anywhere outside a
                  placeholder. Off: your text is sent exactly as written, so you can use numbers freely
                  (&ldquo;24x7&rdquo;, &ldquo;since 1995&rdquo;, GST numbers).
                </span>
              </span>
            </label>
            <div className="space-y-1">
              <Label>Body</Label>
              <div className="flex flex-wrap gap-1.5">
                {PLACEHOLDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => insertPlaceholder(p)}
                    className="rounded-full border border-input bg-muted px-2 py-0.5 text-xs font-mono hover:bg-accent"
                  >
                    {p}
                  </button>
                ))}
              </div>
              <Textarea
                ref={textareaRef}
                rows={8}
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder={`Hi {{contactName}},\n\nI'm reaching out from {{ourBusinessName}}...`}
              />
              <p className="text-xs text-muted-foreground">
                Available: {'{{contactName}}'}, {'{{ourBusinessName}}'}, {'{{businessName}}'}, {'{{city}}'},{' '}
                {'{{state}}'}, {'{{region}}'}, {'{{businessCategory}}'}.
                {useAi ? ' No digits anywhere else while AI rewriting is on.' : ' Numbers are allowed — AI rewriting is off.'}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Make this the active template
            </label>

            {saveError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}

            <div className="flex gap-2">
              <Button onClick={save} disabled={saving || !name.trim() || !bodyText.trim()}>
                {saving ? 'Saving…' : 'Save Template'}
              </Button>
              <Button variant="outline" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        {templates === null ? (
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        ) : templates.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No custom templates yet — the built-in default wording is being used.
          </CardContent>
        ) : (
          <div className="divide-y">
            {templates.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {t.isActive && <Badge>Active</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{t.bodyText}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {!t.isActive && (
                    <Button size="sm" variant="outline" onClick={() => activate(t)}>
                      Activate
                    </Button>
                  )}
                  <Button size="icon-sm" variant="ghost" onClick={() => startEdit(t)} title="Edit">
                    <Pencil />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => remove(t.id)} title="Delete">
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

function SuppressionsSection() {
  const [rows, setRows] = useState<SuppressionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    apiFetch<SuppressionRow[]>('/outreach-email/suppressions')
      .then(setRows)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load suppressions'));
  }

  useEffect(load, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await apiFetch('/outreach-email/suppressions', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim() || undefined,
          phoneE164: phone.trim() || undefined,
          reason,
        }),
      });
      setEmail('');
      setPhone('');
      setReason('');
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not add suppression');
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/outreach-email/suppressions/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove suppression');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        People who should never receive outreach, even if they&apos;re re-imported later.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Add to suppression list</CardTitle>
          <CardDescription>Provide an email or a phone number, plus a short reason.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Phone (E.164)</Label>
              <Input placeholder="+91XXXXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Reason</Label>
              <Input placeholder="Requested no contact" value={reason} onChange={(e) => setReason(e.target.value)} required />
            </div>
            <Button type="submit" disabled={creating || (!email.trim() && !phone.trim())}>
              {creating ? 'Adding…' : 'Add'}
            </Button>
          </form>
          {createError && <p className="mt-2 text-sm text-destructive">{createError}</p>}
        </CardContent>
      </Card>

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      <Card>
        {rows === null ? (
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        ) : rows.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nothing suppressed yet.
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Added</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.email ?? '—'}</TableCell>
                  <TableCell>{r.phoneE164 ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{r.reason}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Button size="icon-sm" variant="ghost" onClick={() => remove(r.id)} title="Remove">
                      <Trash2 className="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
