export { EMAIL_PROVIDER, EmailProviderError } from './email.provider';
export type {
  EmailProvider,
  SendEmailParams,
  DomainVerification,
  EmailWebhookEvent,
  EmailWebhookEventType,
} from './email.provider';
export { EmailModule } from './email.module';
export { ResendProvider } from './resend.provider';
export { SesProvider } from './ses.provider';
export { FakeEmailProvider, fakeWebhookEvent } from './fake.provider';
