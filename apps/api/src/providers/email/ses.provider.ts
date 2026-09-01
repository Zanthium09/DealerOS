import {
  DomainVerification,
  EmailProvider,
  EmailProviderError,
  EmailWebhookEvent,
  InboundReceivedEmail,
  SendEmailParams,
} from './email.provider';

// §6 — "Define SesProvider as a stub so the swap is mechanical." Not implemented: no
// SES credentials or account exist yet. Swapping the provider later is changing
// EMAIL_PROVIDER's useClass in email.module.ts to this, once it is filled in.
export class SesProvider implements EmailProvider {
  send(_params: SendEmailParams): Promise<{ providerMessageId: string }> {
    throw new EmailProviderError('SesProvider is a stub — not implemented (§6).');
  }
  verifyDomain(_domain: string): Promise<DomainVerification> {
    throw new EmailProviderError('SesProvider is a stub — not implemented (§6).');
  }
  getDomainStatus(_domain: string): Promise<DomainVerification> {
    throw new EmailProviderError('SesProvider is a stub — not implemented (§6).');
  }
  parseWebhook(_payload: unknown, _signature: string): EmailWebhookEvent[] {
    throw new EmailProviderError('SesProvider is a stub — not implemented (§6).');
  }
  parseInboundWebhook(_rawBody: Buffer, _headers: Record<string, string>): { providerEventId: string; emailId: string } | null {
    throw new EmailProviderError('SesProvider is a stub — not implemented (§6).');
  }
  fetchReceivedEmail(_emailId: string): Promise<InboundReceivedEmail> {
    throw new EmailProviderError('SesProvider is a stub — not implemented (§6).');
  }
}
