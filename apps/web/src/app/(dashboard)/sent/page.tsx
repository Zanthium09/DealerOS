'use client';

import { Fragment, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';

type Interaction = {
  id: string;
  dealerId: string;
  direction: 'OUTBOUND' | 'INBOUND';
  status: string;
  body: string;
  createdAt: string;
};

type Dealer = { id: string; businessName: string };

const STATUS_STYLE: Record<string, string> = {
  SENT: 'bg-green-100 text-green-800',
  DELIVERED: 'bg-green-100 text-green-800',
  OPENED: 'bg-blue-100 text-blue-800',
  CLICKED: 'bg-blue-100 text-blue-800',
  REPLIED: 'bg-purple-100 text-purple-800',
  BOUNCED: 'bg-red-100 text-red-800',
  FAILED: 'bg-red-100 text-red-800',
  COMPLAINED: 'bg-red-100 text-red-800',
};

export default function SentPage() {
  const [interactions, setInteractions] = useState<Interaction[] | null>(null);
  const [dealerNames, setDealerNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Interaction[]>('/outreach-email/interactions')
      .then(setInteractions)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load history'));
    apiFetch<Dealer[]>('/contacts')
      .then((dealers) => setDealerNames(Object.fromEntries(dealers.map((d) => [d.id, d.businessName]))))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Sent / History</h1>

      {loadError && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b bg-neutral-50 text-left text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Dealer</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {interactions === null ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={3}>
                  Loading…
                </td>
              </tr>
            ) : interactions.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-neutral-500" colSpan={3}>
                  Nothing sent yet.
                </td>
              </tr>
            ) : (
              interactions.map((i) => (
                <Fragment key={i.id}>
                  <tr
                    onClick={() => setExpandedId(expandedId === i.id ? null : i.id)}
                    className="cursor-pointer border-b last:border-0 hover:bg-neutral-50"
                  >
                    <td className="px-4 py-2">{dealerNames[i.dealerId] ?? i.dealerId}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[i.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
                        {i.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{new Date(i.createdAt).toLocaleString()}</td>
                  </tr>
                  {expandedId === i.id && (
                    <tr className="border-b bg-neutral-50 last:border-0">
                      <td colSpan={3} className="px-4 py-3">
                        <p className="mb-1 text-xs font-medium text-neutral-500">
                          Exactly what was sent ({i.direction.toLowerCase()}):
                        </p>
                        <p className="whitespace-pre-wrap text-sm">{i.body}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
