'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Reply, MessageSquareText } from 'lucide-react';

type RepliedMessage = {
  id: string;
  dealerId: string;
  dealer: { businessName: string } | null;
  subject: string;
  toAddress: string;
  body: string;
  replyBody: string | null;
  repliedAt: string | null;
  replyCount: number;
};

export default function RepliesPage() {
  const [messages, setMessages] = useState<RepliedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<RepliedMessage[]>('/outreach-email/messages?onlyReplied=true')
      .then(setMessages)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load replies'));
  }, []);

  const filtered = useMemo(() => {
    if (!messages) return [];
    const term = search.trim().toLowerCase();
    if (!term) return messages;
    return messages.filter(
      (m) =>
        (m.dealer?.businessName ?? '').toLowerCase().includes(term) ||
        (m.replyBody ?? '').toLowerCase().includes(term) ||
        (m.subject ?? '').toLowerCase().includes(term),
    );
  }, [messages, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Replies</h1>
          <p className="text-sm text-muted-foreground">Every dealer who has replied to an outreach email.</p>
        </div>
        {messages !== null && (
          <Badge variant="secondary" className="gap-1">
            <Reply className="size-3.5" />
            {messages.length} {messages.length === 1 ? 'reply' : 'replies'}
          </Badge>
        )}
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {messages !== null && messages.length > 0 && (
        <Input
          placeholder="Search company, reply text, subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      )}

      {messages === null ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
            <MessageSquareText className="size-8" />
            {messages.length === 0 ? (
              <p className="text-sm">No replies yet. They&apos;ll show up here as soon as a dealer writes back.</p>
            ) : (
              <p className="text-sm">No replies match &ldquo;{search}&rdquo;.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => {
            const open = openId === m.id;
            return (
              <Card key={m.id} className="cursor-pointer" onClick={() => setOpenId(open ? null : m.id)}>
                <CardContent className="space-y-2 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{m.dealer?.businessName ?? m.dealerId}</p>
                      <p className="truncate text-xs text-muted-foreground">{m.subject || 'No subject'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {m.replyCount > 1 && <Badge variant="outline">{m.replyCount} replies</Badge>}
                      {m.repliedAt && (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {new Date(m.repliedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <p
                    className={
                      open
                        ? 'whitespace-pre-wrap rounded-lg border border-green-300 bg-green-50 p-3 text-sm'
                        : 'truncate text-sm text-muted-foreground'
                    }
                  >
                    {m.replyBody}
                  </p>
                  {open && (
                    <div className="space-y-1 border-t pt-2">
                      <p className="text-xs font-medium text-muted-foreground">What we sent</p>
                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{m.body}</p>
                    </div>
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
