'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Repeat, Clock, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string | null;
  scheduledAt: string | null;
  maxDealersPerRun: number | null;
  segmentFilter: Record<string, unknown>;
  lastRunAt: string | null;
  lastError: string | null;
};

const SOURCES = ['MANUAL', 'IMPORTED_LIST', 'TRADE_FAIR', 'INQUIRY', 'REFERRAL', 'DISCOVERED'];

// A few common patterns, not a full cron parser — good enough to sanity-check what
// a preset or a hand-typed expression will actually do.
function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;
  if (dom === '*' && dow === '*' && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && dow === '*' && hour.startsWith('*/')) {
    return `Every ${hour.slice(2)} hours`;
  }
  if (dom === '*' && dow === '1-5' && /^\d+$/.test(hour)) {
    return `Weekdays at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && /^\d+$/.test(dow) && /^\d+$/.test(hour)) {
    const days = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    return `${days[Number(dow)] ?? `Day ${dow}`} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  return cron;
}

function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
  const diffDay = Math.round(diffHour / 24);
  return rtf.format(diffDay, 'day');
}

const PRESETS: { label: string; cron: (hour: string) => string }[] = [
  { label: 'Daily at hour', cron: (h) => `0 ${h} * * *` },
  { label: 'Every N hours', cron: (h) => `0 */${h} * * *` },
  { label: 'Weekdays at hour', cron: (h) => `0 ${h} * * 1-5` },
  { label: 'Weekly (Monday) at hour', cron: (h) => `0 ${h} * * 1` },
];

// Local datetime-local value (yyyy-MM-ddTHH:mm) an hour from now, as a sane default.
function defaultLocalDateTime(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [kind, setKind] = useState<'recurring' | 'once'>('recurring');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState(0);
  const [presetHour, setPresetHour] = useState('9');
  const [cron, setCron] = useState('0 9 * * *');
  const [oneTimeAt, setOneTimeAt] = useState(defaultLocalDateTime());
  const [maxDealersPerRun, setMaxDealersPerRun] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [filterCity, setFilterCity] = useState('');
  const [filterState, setFilterState] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    apiFetch<Schedule[]>('/outreach-email/schedules')
      .then(setSchedules)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load schedules'));
  }

  useEffect(load, []);

  function applyPreset(index: number, hour: string) {
    setPreset(index);
    setPresetHour(hour);
    setCron(PRESETS[index].cron(hour));
  }

  async function createSchedule(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const segmentFilter: Record<string, string> = {};
      if (filterCity.trim()) segmentFilter.city = filterCity.trim();
      if (filterState.trim()) segmentFilter.state = filterState.trim();
      if (filterCategory.trim()) segmentFilter.businessCategory = filterCategory.trim();
      if (filterSource) segmentFilter.source = filterSource;

      await apiFetch('/outreach-email/schedules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          cronExpression: kind === 'recurring' ? cron : undefined,
          scheduledAt: kind === 'once' ? new Date(oneTimeAt).toISOString() : undefined,
          enabled,
          maxDealersPerRun: maxDealersPerRun.trim() ? Number(maxDealersPerRun) : undefined,
          segmentFilter: Object.keys(segmentFilter).length > 0 ? segmentFilter : undefined,
        }),
      });
      setName('');
      setMaxDealersPerRun('');
      setFilterCity('');
      setFilterState('');
      setFilterCategory('');
      setFilterSource('');
      toast.success('Schedule created.');
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not create schedule');
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(s: Schedule) {
    setBusyId(s.id);
    try {
      await apiFetch(`/outreach-email/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update schedule');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    try {
      await apiFetch(`/outreach-email/schedules/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete schedule');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Schedules</h1>
        <p className="text-sm text-muted-foreground">
          Recurring or one-time cold-outreach runs. Each fires the same run the Dealers page&apos;s &quot;Run Cold
          Outreach&quot; button triggers, with its own optional dealer cap and segment filter.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createSchedule} className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input className="w-48" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label>Limit dealers per run</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="no limit"
                  className="w-32"
                  value={maxDealersPerRun}
                  onChange={(e) => setMaxDealersPerRun(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 pb-1.5 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                Enabled
              </label>
            </div>

            <div className="space-y-2">
              <Label>Type</Label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={kind === 'recurring' ? 'default' : 'outline'} onClick={() => setKind('recurring')}>
                  <Repeat /> Recurring
                </Button>
                <Button type="button" size="sm" variant={kind === 'once' ? 'default' : 'outline'} onClick={() => setKind('once')}>
                  <Clock /> One-time
                </Button>
              </div>
            </div>

            {kind === 'recurring' ? (
              <div className="space-y-2">
                <Label>When</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {PRESETS.map((p, i) => (
                    <Button
                      key={p.label}
                      type="button"
                      size="sm"
                      variant={preset === i ? 'default' : 'outline'}
                      onClick={() => applyPreset(i, presetHour)}
                    >
                      {p.label}
                    </Button>
                  ))}
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    className="w-16"
                    value={presetHour}
                    onChange={(e) => applyPreset(preset, e.target.value)}
                    title="Hour (0-23), or the N in 'every N hours'"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Label className="shrink-0">Raw cron</Label>
                  <Input className="w-40 font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
                  <span className="text-xs text-muted-foreground">{humanizeCron(cron)}</span>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <Label>Date & time</Label>
                <Input
                  type="datetime-local"
                  className="w-56"
                  value={oneTimeAt}
                  onChange={(e) => setOneTimeAt(e.target.value)}
                  required
                />
              </div>
            )}

            <Separator />

            <div className="space-y-1">
              <Label>Segment filter (optional, blank = no filter)</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Input placeholder="City" className="w-32" value={filterCity} onChange={(e) => setFilterCity(e.target.value)} />
                <Input placeholder="State" className="w-32" value={filterState} onChange={(e) => setFilterState(e.target.value)} />
                <Input
                  placeholder="Business category"
                  className="w-40"
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                />
                <Select
                  value={filterSource || '__any'}
                  onValueChange={(v) => setFilterSource(!v || v === '__any' ? '' : v)}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue>{filterSource || 'Any source'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any">Any source</SelectItem>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {createError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create Schedule'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {loadError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>}

      {schedules === null ? (
        <Skeleton className="h-32 w-full" />
      ) : schedules.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No schedules yet — create one above.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => {
            const isRecurring = s.cronExpression !== null;
            return (
              <Card key={s.id}>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {isRecurring ? (
                        <Badge variant="outline" className="gap-1">
                          <Repeat className="size-3" /> Recurring
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1">
                          <Clock className="size-3" /> One-time
                        </Badge>
                      )}
                      <span className="font-medium">{s.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleEnabled(s)}
                        disabled={busyId === s.id}
                        className="disabled:opacity-50"
                      >
                        <Badge variant={s.enabled ? 'default' : 'secondary'} className="cursor-pointer">
                          {s.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busyId === s.id}
                        onClick={() => remove(s.id)}
                        title="Delete"
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-4">
                    <div>
                      <span className="text-foreground">
                        {isRecurring ? humanizeCron(s.cronExpression!) : new Date(s.scheduledAt!).toLocaleString()}
                      </span>
                      {isRecurring && <span className="ml-1 font-mono text-xs">({s.cronExpression})</span>}
                    </div>
                    <div>Limit: {s.maxDealersPerRun ?? 'No limit'}</div>
                    <div>
                      Last run:{' '}
                      {s.lastRunAt ? (
                        <span title={new Date(s.lastRunAt).toLocaleString()}>{relativeTime(s.lastRunAt)}</span>
                      ) : (
                        'Never run yet'
                      )}
                    </div>
                  </div>

                  {s.lastError && (
                    <Alert variant="destructive">
                      <TriangleAlert />
                      <AlertDescription>Last run failed: {s.lastError}</AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
