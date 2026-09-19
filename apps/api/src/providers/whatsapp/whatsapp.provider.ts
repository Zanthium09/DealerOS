// §1.1 / §1.7 / §7 — WhatsApp goes through Meta's official Cloud API and nothing else:
// never an unofficial library (Baileys, whatsapp-web.js, Venom), never browser automation
// of web.whatsapp.com, never virtual-number rotation. Feature code never calls Meta; it
// injects WHATSAPP_PROVIDER.
//
// Direct Cloud API rather than a BSP on purpose (§7): each customer eventually needs their
// own WhatsApp Business Account through Embedded Signup, which needs direct integration —
// a BSP would have to be ripped out later.

export type TemplateDefinition = {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  bodyText: string;
  /** Example values for {{1}}.. — Meta rejects a template with placeholders and no examples. */
  examples: string[];
};

export type TemplateStatusResult = {
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  rejectionReason?: string;
};

/** Everything a webhook can tell us, normalised. Meta's payload shape stays in the provider. */
export type WhatsAppWebhookEvent =
  | {
      type: 'MESSAGE';
      /** The BUSINESS number's id — how the org is found, since no tenant context exists yet. */
      phoneNumberId: string;
      /** Sender's wa_id: digits only, no '+'. */
      from: string;
      profileName: string | null;
      text: string;
      providerMessageId: string;
      at: Date;
    }
  | {
      type: 'STATUS';
      phoneNumberId: string;
      providerMessageId: string;
      status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
      at: Date;
      error: string | null;
    }
  | {
      type: 'TEMPLATE';
      wabaId: string;
      metaTemplateId: string;
      name: string;
      status: TemplateStatusResult['status'];
      reason: string | null;
    }
  | {
      type: 'QUALITY';
      phoneNumberId: string;
      /** FLAGGED | DOWNGRADE | UPGRADE | ONBOARDING … as Meta names it. */
      event: string;
      tier: string | null;
    };

export interface WhatsAppProvider {
  sendTemplate(params: {
    to: string;
    templateName: string;
    language: string;
    params: string[];
  }): Promise<{ providerMessageId: string }>;

  /** Only valid inside an open 24h session. The CALLER enforces that and fails loudly;
   *  a provider must never quietly downgrade a freeform send into something else. */
  sendFreeform(params: { to: string; text: string }): Promise<{ providerMessageId: string }>;

  submitTemplate(template: TemplateDefinition): Promise<{ metaTemplateId: string; status: TemplateStatusResult['status'] }>;
  getTemplateStatus(metaTemplateId: string): Promise<TemplateStatusResult>;

  /**
   * Verifies X-Hub-Signature-256 over the GENUINE raw bytes (§8 — a re-serialised body
   * will not match) and throws if it does not verify. Never trust an unsigned payload.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): WhatsAppWebhookEvent[];

  /** Meta's one-time GET handshake when the webhook URL is registered. */
  verifyChallenge(query: Record<string, string | undefined>): string | null;
}

export const WHATSAPP_PROVIDER = 'WHATSAPP_PROVIDER';

export class WhatsAppProviderError extends Error {}
