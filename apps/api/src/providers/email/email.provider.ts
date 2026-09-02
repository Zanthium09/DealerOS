// §1.7 — feature code never calls Resend/SES directly. It injects EMAIL_PROVIDER.
//
// `tags` travels out on send() and comes back verbatim on the matching webhook event.
// That is the whole mechanism outreach-email uses to know which organization and
// which InteractionEvent a provider webhook belongs to — no cross-org database lookup
// is ever needed to process one (see send.service.ts / webhook.service.ts).
export type SendEmailParams = {
  /** Either a bare address or a display form: `"Name" <user@domain>`. */
  from: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  /** Optional HTML alternative. When set the provider sends multipart, so a client
   *  that cannot render HTML still gets `text`. */
  html?: string;
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

/** Resend's inbound webhook is metadata-only (§6/§8) — the body is fetched
 *  separately by id. `headers` carries In-Reply-To/References, which is what
 *  message-id.ts threads a reply back to the send it answers. */
export type InboundReceivedEmail = {
  headers: Record<string, string>;
  subject: string;
  text: string | null;
  html: string | null;
  fromAddress: string;
};

export interface EmailProvider {
  send(params: SendEmailParams): Promise<{ providerMessageId: string }>;
  verifyDomain(domain: string): Promise<DomainVerification>;
  getDomainStatus(domain: string): Promise<DomainVerification>;
  /** Throws if the signature does not verify. Never trust an unsigned payload (§8). */
  parseWebhook(payload: unknown, signature: string): EmailWebhookEvent[];
  /**
   * A SEPARATE signing secret from parseWebhook's — inbound receiving is a distinct
   * webhook endpoint in the provider's dashboard, with its own secret. Returns the
   * provider's id for the received email (to fetch full content for) and an
   * idempotency key, or null if this event type is not one this app processes.
   * Throws if the signature does not verify (§8) — never trust an unsigned payload,
   * inbound or outbound alike.
   */
  parseInboundWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): { providerEventId: string; emailId: string } | null;
  /** Inbound webhooks are metadata-only; this fetches the actual message content. */
  fetchReceivedEmail(emailId: string): Promise<InboundReceivedEmail>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
export class EmailProviderError extends Error {}
