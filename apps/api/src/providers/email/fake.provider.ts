import { randomUUID } from 'node:crypto';
import {
  DomainVerification,
  EmailProvider,
  EmailProviderError,
  EmailWebhookEvent,
  EmailWebhookEventType,
  InboundReceivedEmail,
  SendEmailParams,
} from './email.provider';

/**
 * Deterministic EmailProvider for tests and local runs — no key, no network (§13).
 * Mirrors FakeAIProvider: records every call, lets the test script exactly what
 * happens next (a delivery, a bounce, a click) via `emitWebhook`.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: (SendEmailParams & { providerMessageId: string })[] = [];
  readonly domains = new Map<string, DomainVerification>();

  async send(params: SendEmailParams): Promise<{ providerMessageId: string }> {
    const providerMessageId = `fake-msg-${randomUUID()}`;
    this.sent.push({ ...params, providerMessageId });
    return { providerMessageId };
  }

  async verifyDomain(domain: string): Promise<DomainVerification> {
    const v: DomainVerification = { domain, status: 'PENDING', dkimRecords: [] };
    this.domains.set(domain, v);
    return v;
  }

  async getDomainStatus(domain: string): Promise<DomainVerification> {
    return this.domains.get(domain) ?? { domain, status: 'UNVERIFIED', dkimRecords: [] };
  }

  /** Test helper — set what getDomainStatus returns without going through verifyDomain. */
  setDomainStatus(domain: string, status: DomainVerification['status']): void {
    this.domains.set(domain, { domain, status, dkimRecords: [] });
  }

  // The fake's "payload" IS the EmailWebhookEvent shape already — callers build it
  // with `fakeWebhookPayload()` below. Signature must equal 'test-signature'; wrong
  // signature throws, same contract as the real provider (§8).
  parseWebhook(payload: unknown, signature: string): EmailWebhookEvent[] {
    if (signature !== 'test-signature') {
      throw new EmailProviderError('fake webhook signature does not verify (§8)');
    }
    return payload as EmailWebhookEvent[];
  }

  /** Test-settable: what fetchReceivedEmail returns for a given emailId. */
  readonly receivedEmails = new Map<string, InboundReceivedEmail>();

  // Same contract as the real provider: a fixed valid signature, wrong/missing
  // headers throw. The payload IS the parsed body already (tests build it directly),
  // so there is no JSON.parse step to fake.
  parseInboundWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): { providerEventId: string; emailId: string } | null {
    const sig = headers['svix-signature'] ?? headers['x-fake-signature'];
    if (sig !== 'v1,test-inbound-signature') {
      throw new EmailProviderError('fake inbound webhook signature does not verify (§8)');
    }
    const body = JSON.parse(rawBody.toString('utf8'));
    if (body.type !== 'email.received') return null;
    const emailId = body.data?.email_id;
    if (!emailId) return null;
    return { providerEventId: `email.received:${emailId}`, emailId };
  }

  async fetchReceivedEmail(emailId: string): Promise<InboundReceivedEmail> {
    const found = this.receivedEmails.get(emailId);
    if (!found) throw new EmailProviderError(`fake: no received email ${emailId} set up`);
    return found;
  }
}

/** Builds a fake inbound webhook's raw body + headers, matching the real Svix shape
 *  closely enough for the controller/service under test to exercise the real path. */
export function fakeInboundWebhookRequest(emailId: string): { rawBody: Buffer; headers: Record<string, string> } {
  const body = JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: emailId } });
  return {
    rawBody: Buffer.from(body, 'utf8'),
    headers: { 'svix-id': 'msg_fake', 'svix-timestamp': `${Math.floor(Date.now() / 1000)}`, 'svix-signature': 'v1,test-inbound-signature' },
  };
}

/** Builds a webhook payload for a message this fake actually sent. */
export function fakeWebhookEvent(
  providerMessageId: string,
  type: EmailWebhookEventType,
  tags: Record<string, string>,
  providerEventId = `evt-${randomUUID()}`,
): EmailWebhookEvent[] {
  return [{ providerEventId, providerMessageId, type, tags, occurredAt: new Date() }];
}
