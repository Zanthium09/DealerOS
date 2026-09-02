'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, Gauge, PauseCircle, PlayCircle } from 'lucide-react';

type Settings = {
  throttleEnabled: boolean;
  warmupEnabled: boolean;
  dailyLimit: number;
  minSendIntervalMs: number;
  emailPaused: boolean;
  usedToday: number;
  effectiveDailyLimit: number | null;
};

export function SendingControlsSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dailyLimit, setDailyLimit] = useState('');
  const [interval, setInterval] = useState('');

  function load() {
    apiFetch<Settings>('/outreach-email/settings')
      .then((s) => {
        setSettings(s);
        setDailyLimit(String(s.dailyLimit));
        setInterval(String(s.minSendIntervalMs));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load settings'));
  }

  useEffect(load, []);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/outreach-email/settings', { method: 'PATCH', body: JSON.stringify(body) });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <Skeleton className="h-64 w-full" />;
  }

  const unlimited = settings.effectiveDailyLimit === null;
  const remaining = unlimited ? null : Math.max(0, settings.effectiveDailyLimit! - settings.usedToday);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {settings.emailPaused && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          Email sending is paused. Nothing will go out until you resume it.
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" /> Throttle
          </CardTitle>
          <CardDescription>
            Controls how many emails this organization may send per day. Turn it off to send as fast as your
            provider allows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Daily send limit</p>
              <p className="text-xs text-muted-foreground">
                {settings.throttleEnabled
                  ? 'On — the app enforces a daily cap.'
                  : 'Off — no app-level cap. Only your provider’s limits apply.'}
              </p>
            </div>
            <Button
              variant={settings.throttleEnabled ? 'default' : 'outline'}
              disabled={saving}
              onClick={() => patch({ throttleEnabled: !settings.throttleEnabled })}
            >
              {settings.throttleEnabled ? 'Enabled' : 'Disabled'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Domain warm-up ramp</p>
              <p className="text-xs text-muted-foreground">
                Starts at 20/day and rises over two weeks. Protects a brand-new domain’s reputation — turn off
                only if this domain already sends reliably.
              </p>
            </div>
            <Button
              variant={settings.warmupEnabled ? 'default' : 'outline'}
              disabled={saving}
              onClick={() => patch({ warmupEnabled: !settings.warmupEnabled })}
            >
              {settings.warmupEnabled ? 'On' : 'Off'}
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dailyLimit">Daily limit (0 = unlimited)</Label>
              <div className="flex gap-2">
                <Input
                  id="dailyLimit"
                  type="number"
                  min={0}
                  value={dailyLimit}
                  disabled={!settings.throttleEnabled}
                  onChange={(e) => setDailyLimit(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={saving || !settings.throttleEnabled}
                  onClick={() => patch({ dailyLimit: Number(dailyLimit) })}
                >
                  Save
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="interval">Gap between sends (ms)</Label>
              <div className="flex gap-2">
                <Input
                  id="interval"
                  type="number"
                  min={0}
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                />
                <Button variant="outline" disabled={saving} onClick={() => patch({ minSendIntervalMs: Number(interval) })}>
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Your provider’s rate limit, not ours — Resend allows about 2 per second. Always applied.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <Badge variant="secondary">Sent today: {settings.usedToday}</Badge>
            <Badge variant={unlimited ? 'secondary' : remaining === 0 ? 'destructive' : 'outline'}>
              {unlimited ? 'No daily limit' : `${remaining} remaining of ${settings.effectiveDailyLimit}`}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Emergency stop</CardTitle>
          <CardDescription>Halts every outbound email immediately, without a deploy. Replies still arrive.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant={settings.emailPaused ? 'default' : 'destructive'}
            disabled={saving}
            onClick={() => patch({ emailPaused: !settings.emailPaused })}
          >
            {settings.emailPaused ? (
              <>
                <PlayCircle className="size-4" /> Resume sending
              </>
            ) : (
              <>
                <PauseCircle className="size-4" /> Pause all email
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
