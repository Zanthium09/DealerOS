// §1.7 — feature code never calls Resend/SES directly. It injects EMAIL_PROVIDER.
//
// `tags` travels out on send() and comes back verbatim on the matching webhook event.
// That is the whole mechanism outreach-email uses to know which organization and
// which InteractionEvent a provider webhook belongs to — no cross-org database lookup
// is ever needed to process one (see send.service.ts / webhook.service.ts).
export type SendEmailParams = {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** e.g. List-Unsubscribe, List-Unsubscribe-Post, Message-ID (§6). */
  headers: Record<string, string>;
  /** Echoed back verbatim on every webhook event for this message. Never PII — see
   *  send.service.ts, which puts organizationId/interactionEventId here, nothing else. */
  tags: Record<string, string>;
};

export type DomainVerification = {
  domain: string;
  status: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'FAILED';
  dkimRecords: unknown[];
};

export type EmailWebhookEventType =
  | 'DELIVERED'
  | 'OPENED'
  | 'CLICKED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'FAILED';

export type EmailWebhookEvent = {
  providerEventId: string;
  providerMessageId: string;
  type: EmailWebhookEventType;
  tags: Record<string, string>;
  occurredAt: Date;
};

export interface EmailProvider {
  send(params: SendEmailParams): Promise<{ providerMessageId: string }>;
  verifyDomain(domain: string): Promise<DomainVerification>;
  getDomainStatus(domain: string): Promise<DomainVerification>;
  /** Throws if the signature does not verify. Never trust an unsigned payload (§8). */
  parseWebhook(payload: unknown, signature: string): EmailWebhookEvent[];
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
export class EmailProviderError extends Error {}
