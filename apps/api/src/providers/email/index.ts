export { EMAIL_PROVIDER, EmailProviderError } from './email.provider';
export type {
  EmailProvider,
  SendEmailParams,
  DomainVerification,
  EmailWebhookEvent,
  EmailWebhookEventType,
  InboundReceivedEmail,
} from './email.provider';
export { EmailModule } from './email.module';
export { ResendProvider, htmlToPlainText } from './resend.provider';
export { SesProvider } from './ses.provider';
export { FakeEmailProvider, fakeWebhookEvent, fakeInboundWebhookRequest } from './fake.provider';
