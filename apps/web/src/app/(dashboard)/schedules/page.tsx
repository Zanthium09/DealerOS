'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';

type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string;
  maxDealersPerRun: number | null;
  segmentFilter: Record<string, unknown>;
  lastRunAt: string | null;
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

const PRESETS: { label: string; cron: (hour: string) => string }[] = [
  { label: 'Daily at hour', cron: (h) => `0 ${h} * * *` },
  { label: 'Every N hours', cron: (h) => `0 */${h} * * *` },
  { label: 'Weekdays at hour', cron: (h) => `0 ${h} * * 1-5` },
  { label: 'Weekly (Monday) at hour', cron: (h) => `0 ${h} * * 1` },
];

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [preset, setPreset] = useState(0);
  const [presetHour, setPresetHour] = useState('9');
  const [cron, setCron] = useState('0 9 * * *');
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
          cronExpression: cron,
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
      setLoadError(err instanceof ApiError ? err.message : 'Could not update schedule');
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
      setLoadError(err instanceof ApiError ? err.message : 'Could not delete schedule');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Schedules</h1>
      <p className="text-sm text-neutral-500">
        Recurring cold-outreach runs. Each schedule fires the same run that the Dealers page&apos;s &quot;Run Cold
        Outreach&quot; button triggers, on a cron timer, with its own optional dealer cap and segment filter.
      </p>

      <form onSubmit={createSchedule} className="space-y-4 rounded border bg-white p-4">
        <h2 className="text-sm font-semibold">New Schedule</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-neutral-600">Name</label>
            <input
              className="w-48 rounded border px-2 py-1.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-neutral-600">Limit dealers per run</label>
            <input
              type="number"
              min={1}
              placeholder="no limit"
              className="w-32 rounded border px-2 py-1.5 text-sm"
              value={maxDealersPerRun}
              onChange={(e) => setMaxDealersPerRun(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-neutral-600">When</label>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(i, presetHour)}
                className={`rounded border px-2 py-1 text-xs ${
                  preset === i ? 'border-neutral-900 bg-neutral-900 text-white' : 'text-neutral-600'
                }`}
              >
                {p.label}
              </button>
            ))}
            <input
              type="number"
              min={0}
              max={23}
              className="w-16 rounded border px-2 py-1 text-xs"
              value={presetHour}
              onChange={(e) => applyPreset(preset, e.target.value)}
              title="Hour (0-23), or the N in 'every N hours'"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-neutral-600">Raw cron</label>
            <input
              className="w-40 rounded border px-2 py-1.5 font-mono text-sm"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
            <span className="text-xs text-neutral-500">{humanizeCron(cron)}</span>
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-neutral-600">
            Segment filter (optional, blank = no filter)
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              placeholder="City"
              className="w-32 rounded border px-2 py-1.5 text-sm"
              value={filterCity}
              onChange={(e) => setFilterCity(e.target.value)}
            />
            <input
              placeholder="State"
              className="w-32 rounded border px-2 py-1.5 text-sm"
              value={filterState}
              onChange={(e) => setFilterState(e.target.value)}
            />
            <input
              placeholder="Business category"
              className="w-40 rounded border px-2 py-1.5 text-sm"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
            />
            <select
              className="rounded border px-2 py-1.5 text-sm"
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value)}
            >
              <option value="">Any source</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {createError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{createError}</p>}

        <button
          type="submit"
          disabled={creating}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create Schedule'}
        </button>
      </form>

      {loadError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b bg-neutral-50 text-left text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Limit</th>
              <th className="px-4 py-2 font-medium">Enabled</th>
              <th className="px-4 py-2 font-medium">Last run</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {schedules === null ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : schedules.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={6}>
                  No schedules yet — create one above.
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="px-4 py-2">{s.name}</td>
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs text-neutral-500">{s.cronExpression}</span>
                    <span className="ml-2">{humanizeCron(s.cronExpression)}</span>
                  </td>
                  <td className="px-4 py-2">{s.maxDealersPerRun ?? 'No limit'}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => toggleEnabled(s)}
                      disabled={busyId === s.id}
                      className={`rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
                        s.enabled ? 'bg-green-100 text-green-800' : 'bg-neutral-100 text-neutral-700'
                      }`}
                    >
                      {s.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-neutral-500">
                    {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : 'Never run yet'}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => remove(s.id)}
                      disabled={busyId === s.id}
                      className="rounded border px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
