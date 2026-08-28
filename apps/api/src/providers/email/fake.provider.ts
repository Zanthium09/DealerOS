import { randomUUID } from 'node:crypto';
import {
  DomainVerification,
  EmailProvider,
  EmailProviderError,
  EmailWebhookEvent,
  EmailWebhookEventType,
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
