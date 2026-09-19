import { randomUUID } from 'node:crypto';
import { normalizeWebhook } from './cloud-api.provider';
import { signMetaPayload, verifyMetaSignature } from './signature';
import {
  TemplateDefinition,
  TemplateStatusResult,
  WhatsAppProvider,
  WhatsAppProviderError,
  WhatsAppWebhookEvent,
} from './whatsapp.provider';

export const FAKE_APP_SECRET = 'test-whatsapp-app-secret';

/**
 * Deterministic WhatsAppProvider for tests and local runs — no token, no network (§13).
 * Records every call. Webhook verification uses the REAL signature check against a known
 * secret, so a test that gets the signature wrong fails the way production would.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly templates: { to: string; templateName: string; language: string; params: string[] }[] = [];
  readonly freeform: { to: string; text: string }[] = [];
  readonly submitted: TemplateDefinition[] = [];
  templateStatus: TemplateStatusResult = { status: 'APPROVED' };
  failNextSend: string | null = null;

  private id() {
    return `wamid.fake-${randomUUID()}`;
  }

  async sendTemplate(p: { to: string; templateName: string; language: string; params: string[] }) {
    if (this.failNextSend) {
      const m = this.failNextSend;
      this.failNextSend = null;
      throw new WhatsAppProviderError(m);
    }
    this.templates.push(p);
    return { providerMessageId: this.id() };
  }

  async sendFreeform(p: { to: string; text: string }) {
    if (this.failNextSend) {
      const m = this.failNextSend;
      this.failNextSend = null;
      throw new WhatsAppProviderError(m);
    }
    this.freeform.push(p);
    return { providerMessageId: this.id() };
  }

  async submitTemplate(t: TemplateDefinition) {
    this.submitted.push(t);
    return { metaTemplateId: `fake-tpl-${randomUUID()}`, status: 'PENDING' as const };
  }

  async getTemplateStatus(): Promise<TemplateStatusResult> {
    return this.templateStatus;
  }

  verifyChallenge(q: Record<string, string | undefined>): string | null {
    return q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === 'test-verify-token' ? (q['hub.challenge'] ?? null) : null;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string>): WhatsAppWebhookEvent[] {
    if (!verifyMetaSignature(rawBody, headers['x-hub-signature-256'], FAKE_APP_SECRET)) {
      throw new WhatsAppProviderError('fake webhook signature does not verify (§8)');
    }
    return normalizeWebhook(JSON.parse(rawBody.toString('utf8')));
  }
}

/** A correctly signed webhook request for a Meta-shaped body. */
export function fakeSignedWebhook(body: unknown): { rawBody: Buffer; headers: Record<string, string> } {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { rawBody, headers: { 'x-hub-signature-256': signMetaPayload(rawBody, FAKE_APP_SECRET) } };
}
