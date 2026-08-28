import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DomainVerification,
  EmailProvider,
  EmailProviderError,
  EmailWebhookEvent,
  SendEmailParams,
} from './email.provider';

// §6 — the real implementation. Never called in tests (no network, no API key here);
// FakeEmailProvider stands in everywhere §13 needs deterministic behaviour.
export class ResendProvider implements EmailProvider {
  constructor(
    private readonly apiKey = process.env.RESEND_API_KEY,
    private readonly webhookSecret = process.env.RESEND_WEBHOOK_SECRET,
    private readonly baseUrl = 'https://api.resend.com',
  ) {}

  private requireKey(): string {
    if (!this.apiKey) throw new EmailProviderError('RESEND_API_KEY is not set');
    return this.apiKey;
  }

  async send(params: SendEmailParams): Promise<{ providerMessageId: string }> {
    const res = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.requireKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: params.from,
        to: [params.to],
        subject: params.subject,
        text: params.text,
        headers: params.headers,
        tags: Object.entries(params.tags).map(([name, value]) => ({ name, value })),
      }),
    });
    if (!res.ok) {
      throw new EmailProviderError(`Resend send failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    return { providerMessageId: body.id };
  }

  async verifyDomain(domain: string): Promise<DomainVerification> {
    const res = await fetch(`${this.baseUrl}/domains`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.requireKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: domain }),
    });
    if (!res.ok) throw new EmailProviderError(`Resend verifyDomain failed: ${res.status}`);
    const body = (await res.json()) as { status: string; records: unknown[] };
    return { domain, status: mapStatus(body.status), dkimRecords: body.records ?? [] };
  }

  async getDomainStatus(domain: string): Promise<DomainVerification> {
    const res = await fetch(`${this.baseUrl}/domains`, {
      headers: { Authorization: `Bearer ${this.requireKey()}` },
    });
    if (!res.ok) throw new EmailProviderError(`Resend getDomainStatus failed: ${res.status}`);
    const body = (await res.json()) as { data: { name: string; status: string; records: unknown[] }[] };
    const found = body.data.find((d) => d.name === domain);
    if (!found) return { domain, status: 'UNVERIFIED', dkimRecords: [] };
    return { domain, status: mapStatus(found.status), dkimRecords: found.records ?? [] };
  }

  // Resend signs webhooks the Svix way: `svix-id.svix-timestamp.body`, HMAC-SHA256
  // with the base64-decoded signing secret, compared as `v1,<base64 sig>`.
  parseWebhook(payload: unknown, signature: string): EmailWebhookEvent[] {
    if (!this.webhookSecret) throw new EmailProviderError('RESEND_WEBHOOK_SECRET is not set');
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const secretKey = Buffer.from(this.webhookSecret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', secretKey).update(raw).digest('base64');
    const given = signature.split(' ').map((s) => s.split(',')[1]).find(Boolean) ?? signature;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new EmailProviderError('Resend webhook signature does not verify (§8)');
    }
    const body = typeof payload === 'string' ? JSON.parse(payload) : (payload as any);
    const type = mapEventType(body.type);
    if (!type) return [];
    const tags: Record<string, string> = {};
    for (const t of body.data?.tags ?? []) tags[t.name] = t.value;
    return [
      {
        providerEventId: body.data?.email_id ? `${body.type}:${body.data.email_id}:${body.created_at}` : body.id,
        providerMessageId: body.data?.email_id,
        type,
        tags,
        occurredAt: new Date(body.created_at ?? Date.now()),
      },
    ];
  }
}

function mapStatus(s: string): DomainVerification['status'] {
  if (s === 'verified') return 'VERIFIED';
  if (s === 'pending') return 'PENDING';
  if (s === 'failed') return 'FAILED';
  return 'UNVERIFIED';
}

function mapEventType(t: string): EmailWebhookEvent['type'] | null {
  switch (t) {
    case 'email.delivered':
      return 'DELIVERED';
    case 'email.opened':
      return 'OPENED';
    case 'email.clicked':
      return 'CLICKED';
    case 'email.bounced':
      return 'BOUNCED';
    case 'email.complained':
      return 'COMPLAINED';
    case 'email.delivery_delayed':
    case 'email.failed':
      return 'FAILED';
    default:
      return null;
  }
}
