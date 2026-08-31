'use client';

import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';

type SendingIdentity = {
  id: string;
  domain: string;
  provider: string;
  verificationStatus: string;
  currentDailyLimit: number;
  warmupStartedAt: string | null;
};

export default function SettingsPage() {
  const [identities, setIdentities] = useState<SendingIdentity[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [provider, setProvider] = useState('resend');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

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
      setLoadError(err instanceof ApiError ? err.message : 'Could not verify');
    } finally {
      setVerifyingId(null);
    }
  }

  const hasVerified = identities?.some((i) => i.verificationStatus === 'VERIFIED') ?? false;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings — Sending Identities</h1>

      {!hasVerified && identities !== null && (
        <p className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Cold outreach emails cannot be sent until at least one sending identity is verified below.
        </p>
      )}

      <form onSubmit={addIdentity} className="flex flex-wrap items-end gap-3 rounded border bg-white p-4">
        <div className="space-y-1">
          <label className="text-sm font-medium">Domain</label>
          <input
            className="rounded border px-3 py-1.5 text-sm"
            placeholder="mail-yourorg.in"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Provider</label>
          <input
            className="rounded border px-3 py-1.5 text-sm"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {creating ? 'Adding…' : 'Add Sending Identity'}
        </button>
      </form>
      {createError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{createError}</p>}
      {loadError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b bg-neutral-50 text-left text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-4 py-2 font-medium">Provider</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Daily limit</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {identities === null ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={5}>
                  Loading…
                </td>
              </tr>
            ) : identities.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={5}>
                  No sending identities yet — add one above.
                </td>
              </tr>
            ) : (
              identities.map((i) => (
                <tr key={i.id} className="border-b last:border-0">
                  <td className="px-4 py-2">{i.domain}</td>
                  <td className="px-4 py-2">{i.provider}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        i.verificationStatus === 'VERIFIED' ? 'bg-green-100 text-green-800' : 'bg-neutral-100 text-neutral-700'
                      }`}
                    >
                      {i.verificationStatus}
                    </span>
                  </td>
                  <td className="px-4 py-2">{i.currentDailyLimit}</td>
                  <td className="px-4 py-2">
                    {i.verificationStatus !== 'VERIFIED' && (
                      <button
                        onClick={() => markVerified(i.id)}
                        disabled={verifyingId === i.id}
                        title="Mark verified only after you've confirmed the SPF/DKIM/DMARC DNS records with your email provider — this button does not check DNS itself."
                        className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                      >
                        {verifyingId === i.id ? 'Marking…' : 'Mark Verified'}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">
        &quot;Mark Verified&quot; is a manual stand-in: click it only after you have confirmed the SPF, DKIM and DMARC
        DNS records with your email provider. It does not perform an automatic DNS check.
      </p>
    </div>
  );
}
