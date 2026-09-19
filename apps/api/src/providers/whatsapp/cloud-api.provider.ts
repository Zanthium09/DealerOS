import { Injectable } from '@nestjs/common';
import { verifyMetaSignature } from './signature';
import {
  TemplateDefinition,
  TemplateStatusResult,
  WhatsAppProvider,
  WhatsAppProviderError,
  WhatsAppWebhookEvent,
} from './whatsapp.provider';

const TEMPLATE_STATUS: Record<string, TemplateStatusResult['status']> = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PENDING: 'PENDING',
  IN_APPEAL: 'PENDING',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  PENDING_DELETION: 'DISABLED',
};

/**
 * Meta WhatsApp Cloud API, called directly with `fetch` — same reasoning as the Gemini
 * and Anthropic providers: a handful of POSTs, not worth an SDK.
 *
 * Configuration comes from the environment for the first (only) customer:
 *   WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID,
 *   WHATSAPP_APP_SECRET (webhook signature), WHATSAPP_VERIFY_TOKEN (GET handshake),
 *   WHATSAPP_API_VERSION (Graph API version — Meta retires old ones, so it is config).
 * Per-customer credentials arrive with Embedded Signup at productisation (§7); the org →
 * number mapping already lives in WhatsAppAccount.
 *
 * Nothing here has been exercised against the live API: it needs a verified WhatsApp
 * Business Account (CLAUDE.md §16.4). The request shapes follow Meta's documented Cloud
 * API; the fake provider stands in everywhere a test needs deterministic behaviour.
 */
@Injectable()
export class CloudApiProvider implements WhatsAppProvider {
  private get version() {
    return process.env.WHATSAPP_API_VERSION || 'v23.0';
  }
  private base() {
    return `https://graph.facebook.com/${this.version}`;
  }
  private require(name: string): string {
    const v = process.env[name];
    if (!v) throw new WhatsAppProviderError(`${name} is not set — WhatsApp is not configured (CLAUDE.md §16.4)`);
    return v;
  }

  private async call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const res = await fetch(`${this.base()}/${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.require('WHATSAPP_ACCESS_TOKEN')}`,
        'content-type': 'application/json',
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      // Meta's own message ("(#131047) Re-engagement message…") is what tells you why;
      // surfacing it is the difference between a diagnosable failure and "Internal error".
      const e = json?.error;
      throw new WhatsAppProviderError(
        `WhatsApp API ${res.status}${e?.code ? ` (#${e.code})` : ''}: ${e?.error_user_msg ?? e?.message ?? text.slice(0, 300)}`,
      );
    }
    return json as T;
  }

  async sendTemplate(p: { to: string; templateName: string; language: string; params: string[] }) {
    const body = {
      messaging_product: 'whatsapp',
      to: p.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: p.templateName,
        language: { code: p.language },
        ...(p.params.length
          ? { components: [{ type: 'body', parameters: p.params.map((text) => ({ type: 'text', text })) }] }
          : {}),
      },
    };
    const out = await this.call<{ messages?: { id: string }[] }>(`${this.require('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
      method: 'POST',
      body,
    });
    const id = out.messages?.[0]?.id;
    if (!id) throw new WhatsAppProviderError('WhatsApp API returned no message id');
    return { providerMessageId: id };
  }

  async sendFreeform(p: { to: string; text: string }) {
    const out = await this.call<{ messages?: { id: string }[] }>(`${this.require('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', to: p.to.replace(/^\+/, ''), type: 'text', text: { body: p.text, preview_url: false } },
    });
    const id = out.messages?.[0]?.id;
    if (!id) throw new WhatsAppProviderError('WhatsApp API returned no message id');
    return { providerMessageId: id };
  }

  async submitTemplate(t: TemplateDefinition) {
    const out = await this.call<{ id: string; status?: string }>(`${this.require('WHATSAPP_WABA_ID')}/message_templates`, {
      method: 'POST',
      body: {
        name: t.name,
        language: t.language,
        category: t.category,
        components: [
          {
            type: 'BODY',
            text: t.bodyText,
            ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}),
          },
        ],
      },
    });
    return { metaTemplateId: out.id, status: TEMPLATE_STATUS[out.status ?? 'PENDING'] ?? 'PENDING' };
  }

  async getTemplateStatus(metaTemplateId: string): Promise<TemplateStatusResult> {
    const out = await this.call<{ status?: string; rejected_reason?: string }>(
      `${metaTemplateId}?fields=status,rejected_reason`,
      { method: 'GET' },
    );
    return {
      status: TEMPLATE_STATUS[out.status ?? 'PENDING'] ?? 'PENDING',
      rejectionReason: out.rejected_reason && out.rejected_reason !== 'NONE' ? out.rejected_reason : undefined,
    };
  }

  verifyChallenge(query: Record<string, string | undefined>): string | null {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!expected) return null;
    return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected ? (query['hub.challenge'] ?? null) : null;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string>): WhatsAppWebhookEvent[] {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) throw new WhatsAppProviderError('WHATSAPP_APP_SECRET is not set — cannot verify webhooks');
    const sig = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'];
    if (!verifyMetaSignature(rawBody, sig, secret)) {
      throw new WhatsAppProviderError('WhatsApp webhook signature does not verify (§8)');
    }
    return normalizeWebhook(JSON.parse(rawBody.toString('utf8')));
  }
}

const at = (ts: unknown) => new Date(Number(ts) * 1000 || Date.now());

/** Meta's nested payload → flat events. Pure, so it is tested without a network. */
export function normalizeWebhook(body: any): WhatsAppWebhookEvent[] {
  const events: WhatsAppWebhookEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      switch (change?.field) {
        case 'messages': {
          const phoneNumberId = v.metadata?.phone_number_id;
          if (!phoneNumberId) break;
          const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
          for (const m of v.messages ?? []) {
            events.push({
              type: 'MESSAGE',
              phoneNumberId,
              from: String(m.from),
              profileName: names.get(m.from) ?? null,
              text: messageText(m),
              providerMessageId: m.id,
              at: at(m.timestamp),
            });
          }
          for (const s of v.statuses ?? []) {
            const status = String(s.status).toUpperCase();
            if (!['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status)) continue;
            events.push({
              type: 'STATUS',
              phoneNumberId,
              providerMessageId: s.id,
              status: status as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
              at: at(s.timestamp),
              error: s.errors?.[0] ? `#${s.errors[0].code} ${s.errors[0].title ?? s.errors[0].message ?? ''}`.trim() : null,
            });
          }
          break;
        }
        case 'message_template_status_update': {
          const status = TEMPLATE_STATUS[String(v.event ?? '').toUpperCase()];
          if (!status || !entry.id) break;
          events.push({
            type: 'TEMPLATE',
            wabaId: String(entry.id),
            metaTemplateId: String(v.message_template_id ?? ''),
            name: String(v.message_template_name ?? ''),
            status,
            reason: v.reason && v.reason !== 'NONE' ? String(v.reason) : null,
          });
          break;
        }
        case 'phone_number_quality_update': {
          const phoneNumberId = v.metadata?.phone_number_id ?? null;
          if (!phoneNumberId || !v.event) break;
          events.push({ type: 'QUALITY', phoneNumberId, event: String(v.event), tier: v.current_limit ?? null });
          break;
        }
      }
    }
  }
  return events;
}

function messageText(m: any): string {
  if (m.type === 'text') return String(m.text?.body ?? '');
  if (m.type === 'button') return String(m.button?.text ?? '');
  if (m.type === 'interactive') return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '');
  // A media message has no text to classify; keep a marker so the history is truthful
  // and a human sees that something non-text arrived.
  return `[${m.type ?? 'unsupported'} message]`;
}
