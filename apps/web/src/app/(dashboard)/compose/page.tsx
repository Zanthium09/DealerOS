'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { Search, Send, Save, Building2, Mail, UserPlus } from 'lucide-react';

type Dealer = {
  id: string;
  businessName: string;
  contactPersonName: string | null;
  city: string | null;
  state: string | null;
  businessCategory: string | null;
  pipelineStage: string;
  emails: { address: string; isPrimary: boolean; verificationStatus: string }[];
};

type Template = { id: string; name: string; subject: string; bodyText: string; useAi: boolean };

const PLACEHOLDERS = [
  'businessName',
  'contactName',
  'ourBusinessName',
  'city',
  'state',
  'region',
  'businessCategory',
];

export default function ComposePage() {
  const [mode, setMode] = useState<'search' | 'manual'>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Dealer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Dealer | null>(null);

  const [manualName, setManualName] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualContact, setManualContact] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    apiFetch<Template[]>('/outreach-email/templates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  // Debounced so typing a company name does not fire a request per keystroke.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      setSearching(true);
      apiFetch<Dealer[]>(`/contacts?search=${encodeURIComponent(query.trim())}&take=25`)
        // Guarded: a slower earlier request must not overwrite a newer one's
        // results, or the list shows matches for a query you already replaced.
        .then((rows) => current && setResults(rows))
        .catch((err) => current && setError(err instanceof ApiError ? err.message : 'Search failed'))
        .finally(() => current && setSearching(false));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  const primaryEmail = useMemo(() => {
    if (!selected) return null;
    return selected.emails.find((e) => e.isPrimary) ?? selected.emails[0] ?? null;
  }, [selected]);

  async function addManual() {
    if (!manualName.trim()) return;
    setManualBusy(true);
    setManualError(null);
    try {
      const res = await apiFetch<{ dealer: Dealer; wasExisting: boolean }>('/contacts/quick-add', {
        method: 'POST',
        body: JSON.stringify({
          businessName: manualName,
          email: manualEmail,
          phone: manualPhone,
          contactPersonName: manualContact,
        }),
      });
      setSelected(res.dealer);
      if (res.wasExisting) toast.info(`${res.dealer.businessName} is already in your dealers — using that record`);
      else toast.success(`${res.dealer.businessName} added`);
      setManualName('');
      setManualEmail('');
      setManualPhone('');
      setManualContact('');
      setMode('search');
    } catch (err) {
      setManualError(err instanceof ApiError ? err.message : 'Could not add company');
    } finally {
      setManualBusy(false);
    }
  }

  function applyTemplate(id: string | null) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject || '');
    setBodyText(t.bodyText);
  }

  async function submit(sendNow: boolean) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ draftId?: string; sent: boolean }>('/outreach-email/compose', {
        method: 'POST',
        body: JSON.stringify({
          dealerId: selected.id,
          subject,
          bodyText,
          cc,
          bcc,
          sendNow,
        }),
      });
      toast.success(sendNow ? `Sent to ${selected.businessName}` : 'Saved to the approval queue');
      if (sendNow || res.draftId) {
        setSubject('');
        setBodyText('');
        setCc('');
        setBcc('');
        setSelected(null);
        setQuery('');
        setResults(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send');
    } finally {
      setBusy(false);
    }
  }

  const canSend = selected && subject.trim() && bodyText.trim() && !busy;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Compose</h1>
        <p className="text-sm text-muted-foreground">
          Find a company and write to them directly. Nothing here is AI-written — what you type is what is sent.
        </p>
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {mode === 'search' ? <Search className="size-4" /> : <UserPlus className="size-4" />}
              {mode === 'search' ? 'Find a company' : 'Add a new company'}
            </CardTitle>
            <div className="flex gap-1 pt-1">
              <Button
                type="button"
                size="sm"
                variant={mode === 'search' ? 'default' : 'outline'}
                onClick={() => setMode('search')}
              >
                Search existing
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'manual' ? 'default' : 'outline'}
                onClick={() => setMode('manual')}
              >
                Type it in
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {mode === 'search' ? (
              <>
                <Input
                  placeholder="Business name, city, email…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />

                {searching && <Skeleton className="h-20 w-full" />}

                {results !== null && !searching && (
                  <div className="max-h-96 space-y-1 overflow-y-auto">
                    {results.length === 0 ? (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        No companies matched. Not in the list yet?{' '}
                        <button type="button" className="underline" onClick={() => setMode('manual')}>
                          Type it in
                        </button>
                        .
                      </p>
                    ) : (
                      results.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => setSelected(d)}
                          className={`w-full rounded-lg border p-2 text-left text-sm transition-colors hover:bg-accent ${
                            selected?.id === d.id ? 'border-primary bg-accent' : ''
                          }`}
                        >
                          <p className="font-medium">{d.businessName}</p>
                          <p className="text-xs text-muted-foreground">
                            {[d.city, d.state].filter(Boolean).join(', ') || 'No location'}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {results === null && !searching && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Type at least two characters to search.
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="manualName">Company name</Label>
                  <Input
                    id="manualName"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="Acme Traders"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="manualEmail">Email</Label>
                  <Input
                    id="manualEmail"
                    type="email"
                    value={manualEmail}
                    onChange={(e) => setManualEmail(e.target.value)}
                    placeholder="owner@acmetraders.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="manualContact">Contact person (optional)</Label>
                  <Input
                    id="manualContact"
                    value={manualContact}
                    onChange={(e) => setManualContact(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="manualPhone">Phone (optional)</Label>
                  <Input id="manualPhone" value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} />
                </div>
                {manualError && <p className="text-sm text-destructive">{manualError}</p>}
                <Button
                  className="w-full"
                  disabled={manualBusy || !manualName.trim() || !manualEmail.trim()}
                  onClick={addManual}
                >
                  <UserPlus className="size-4" /> {manualBusy ? 'Adding…' : 'Add and continue'}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Creates a real dealer record — this shows up in Dealers too, with no consent assumed.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="size-4" /> Message
            </CardTitle>
            <CardDescription>
              Use {'{{businessName}}'}, {'{{contactName}}'} and other placeholders — they are filled from that
              company&apos;s own record.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selected ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
                <Building2 className="size-8" />
                <p className="text-sm">Pick a company on the left to start writing.</p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{selected.businessName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {primaryEmail?.address ?? 'No email address on file'}
                      {selected.contactPersonName ? ` · ${selected.contactPersonName}` : ''}
                    </p>
                  </div>
                  <Badge variant="outline">{selected.pipelineStage}</Badge>
                </div>

                {!primaryEmail && (
                  <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    This company has no email address, so nothing can be sent to it.
                  </p>
                )}

                {templates.length > 0 && (
                  <div className="space-y-1.5">
                    <Label>Start from a template</Label>
                    <Select onValueChange={applyTemplate}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a saved template…" />
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
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Dealer partnership — {{businessName}}"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="cc">CC</Label>
                    <Input id="cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bcc">BCC</Label>
                    <Input id="bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="optional" />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="body">Message</Label>
                  <Textarea
                    id="body"
                    rows={12}
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    placeholder="Hello {{contactName}}, …"
                  />
                  <div className="flex flex-wrap gap-1 pt-1">
                    {PLACEHOLDERS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setBodyText((b) => `${b}{{${p}}}`)}
                        className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
                      >
                        {`{{${p}}}`}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button disabled={!canSend || !primaryEmail} onClick={() => submit(true)}>
                    <Send className="size-4" /> Send now
                  </Button>
                  <Button variant="outline" disabled={!canSend} onClick={() => submit(false)}>
                    <Save className="size-4" /> Save to queue
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
