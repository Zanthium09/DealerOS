import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DomainVerification,
  EmailProvider,
  EmailProviderError,
  EmailWebhookEvent,
  InboundReceivedEmail,
  SendEmailParams,
} from './email.provider';

// §6 — the real implementation. Never called in tests (no network, no API key here);
// FakeEmailProvider stands in everywhere §13 needs deterministic behaviour.
export class ResendProvider implements EmailProvider {
  constructor(
    private readonly apiKey = process.env.RESEND_API_KEY,
    private readonly webhookSecret = process.env.RESEND_WEBHOOK_SECRET,
    private readonly baseUrl = 'https://api.resend.com',
    // A separate secret on purpose: Resend issues one per configured webhook
    // endpoint, and inbound receiving is registered as its own endpoint in their
    // dashboard, distinct from the outbound delivery-events one above.
    private readonly inboundWebhookSecret = process.env.RESEND_INBOUND_WEBHOOK_SECRET,
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
        ...(params.cc?.length ? { cc: params.cc } : {}),
        ...(params.bcc?.length ? { bcc: params.bcc } : {}),
        ...(params.replyTo ? { reply_to: params.replyTo } : {}),
        subject: params.subject,
        text: params.text,
        ...(params.html ? { html: params.html } : {}),
        headers: params.headers,
        // Resend rejects tag values outside [A-Za-z0-9_-], and a rejected tag fails
        // the whole send. Ids here are cuid/uuid so they pass, but a stray value
        // would otherwise turn a good message into a hard error at the provider.
        tags: Object.entries(params.tags)
          .filter(([, value]) => value)
          .map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, '_') })),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new EmailProviderError(`Resend send failed (${res.status}): ${extractResendMessage(detail)}`);
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

  // Resend's inbound webhook uses the real Svix scheme: HMAC-SHA256 over
  // `${svix-id}.${svix-timestamp}.${rawBody}`, unlike parseWebhook above which
  // (pre-existing, untouched here) verifies against the body alone. This is over the
  // genuine raw bytes (§8 — a re-serialised body will not match), which is why the
  // controller must pass the untouched Buffer Nest captured before JSON parsing.
  parseInboundWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): { providerEventId: string; emailId: string } | null {
    if (!this.inboundWebhookSecret) throw new EmailProviderError('RESEND_INBOUND_WEBHOOK_SECRET is not set');
    const h = (name: string) => headers[name] ?? headers[name.toLowerCase()];
    const svixId = h('svix-id');
    const svixTimestamp = h('svix-timestamp');
    const svixSignature = h('svix-signature');
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new EmailProviderError('missing svix-id/svix-timestamp/svix-signature headers (§8)');
    }

    const secretKey = Buffer.from(this.inboundWebhookSecret.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
    const expected = createHmac('sha256', secretKey).update(signedContent).digest('base64');
    // svix-signature can carry multiple space-separated `v1,<sig>` values (secret
    // rotation); any one matching is enough.
    const given = svixSignature
      .split(' ')
      .map((s) => s.split(',')[1])
      .filter(Boolean);
    const a = Buffer.from(expected);
    const verified = given.some((g) => {
      const b = Buffer.from(g);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!verified) throw new EmailProviderError('Resend inbound webhook signature does not verify (§8)');

    const body = JSON.parse(rawBody.toString('utf8'));
    if (body.type !== 'email.received') return null;
    const emailId = body.data?.email_id;
    if (!emailId) return null;
    return { providerEventId: `email.received:${emailId}`, emailId };
  }

  async fetchReceivedEmail(emailId: string): Promise<InboundReceivedEmail> {
    const res = await fetch(`${this.baseUrl}/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${this.requireKey()}` },
    });
    if (!res.ok) throw new EmailProviderError(`Resend fetchReceivedEmail failed: ${res.status}`);
    const body = (await res.json()) as {
      headers?: Record<string, string>;
      subject?: string;
      text?: string | null;
      html?: string | null;
      from?: string;
    };
    return {
      headers: body.headers ?? {},
      subject: body.subject ?? '',
      text: body.text ?? null,
      html: body.html ?? null,
      fromAddress: body.from ?? '',
    };
  }
}

/** ponytail: a tag-stripping regex, not an HTML parser — good enough to get plain
 *  text out of a reply for classification/threading when a sender's client only sent
 *  HTML with no text part. Upgrade to a real HTML-to-text library if a reply's
 *  formatting ever needs to be preserved rather than just read. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** Resend returns `{"statusCode":422,"message":"...","name":"validation_error"}`.
 *  Surfacing that message is the difference between "Internal server error" and
 *  "the recipient address is not valid" in the dashboard. */
function extractResendMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; name?: string };
    return parsed.message ?? parsed.name ?? body;
  } catch {
    return body || 'no response body';
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
