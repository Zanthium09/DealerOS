import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConsentChannel, InteractionDirection, InteractionStatus } from '@prisma/client';

// §8 — "the per-provider signature scheme goes behind an interface, since §6 and §7
// both need one." One adapter per provider (`whatsapp`, an email provider's name, …),
// looked up by the `:provider` segment of the webhook URL.
export interface WebhookAdapter {
  /** Verifies the signature over the RAW body. Must run before the body is trusted at all. */
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;

  /** A stable id for this event, unique per real occurrence — WebhookEvent's dedup key. */
  extractEventId(payload: unknown): string | null;

  /**
   * Turns a verified, deduped payload into the InteractionEvent it represents.
   * Returns null for a payload this adapter recognises but that logs nothing (e.g. a
   * verification challenge) — the WebhookEvent is still marked processed, just with
   * no InteractionEvent written.
   */
  toInteractionEvent(payload: unknown): WebhookInteraction | null;
}

export type WebhookInteraction = {
  organizationId: string;
  dealerId: string;
  channel: ConsentChannel;
  direction: InteractionDirection;
  status: InteractionStatus;
  body: string;
  providerMessageId?: string;
  campaignId?: string;
  messageDraftId?: string;
};

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Generic "HMAC-SHA256 hex digest over the raw body, in a header, optionally
 * prefixed" scheme — what Meta's Cloud API webhooks (`X-Hub-Signature-256:
 * sha256=<hex>`) and plenty of others use. Good enough as the default for both §6 and
 * §7; a provider with a genuinely different scheme (e.g. Svix-style base64) gets its
 * own adapter implementing the same interface.
 */
export function hmacSha256Adapter(config: {
  secret: string;
  signatureHeader: string;
  signaturePrefix?: string;
  /** Dot path to the event id in the parsed payload. Default: "id". */
  eventIdPath?: string;
  toInteractionEvent?: (payload: unknown) => WebhookInteraction | null;
}): WebhookAdapter {
  const prefix = config.signaturePrefix ?? '';
  const idPath = config.eventIdPath ?? 'id';

  return {
    verifySignature(rawBody, headers) {
      const provided = header(headers, config.signatureHeader);
      if (!provided) return false;
      const sig = provided.startsWith(prefix) ? provided.slice(prefix.length) : provided;
      const expected = createHmac('sha256', config.secret).update(rawBody).digest('hex');

      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      // Different lengths would make timingSafeEqual throw rather than return false —
      // an attacker-controlled length must never crash the request path.
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },

    extractEventId(payload) {
      const id = get(payload, idPath);
      return typeof id === 'string' && id.length > 0 ? id : null;
    },

    toInteractionEvent(payload) {
      return config.toInteractionEvent ? config.toInteractionEvent(payload) : null;
    },
  };
}
