/**
 * §6 — "Thread on In-Reply-To / References, falling back to subject + sender."
 *
 * The outbound Message-ID we set ourselves encodes (organizationId, interactionEventId)
 * directly. That means threading a reply back to "which org, which send" never needs a
 * cross-org database lookup — the tenancy layer refuses those by design (§1.3) — it is
 * read straight out of the header the dealer's mail client echoes back.
 */
export function buildMessageId(organizationId: string, interactionEventId: string, domain: string): string {
  return `<${organizationId}.${interactionEventId}@${domain}>`;
}

const MESSAGE_ID_RE = /<([^.@>]+)\.([^@>]+)@[^>]+>/;

export function parseMessageId(value: string): { organizationId: string; interactionEventId: string } | null {
  const m = MESSAGE_ID_RE.exec(value);
  if (!m) return null;
  return { organizationId: m[1], interactionEventId: m[2] };
}

/** Tries In-Reply-To first, then each id in References (most recent last, per RFC 5322,
 *  so scan in reverse to find the message this thread most recently came from). */
export function findThreadedMessageId(headers: Record<string, string>): { organizationId: string; interactionEventId: string } | null {
  const inReplyTo = headers['In-Reply-To'] ?? headers['in-reply-to'];
  if (inReplyTo) {
    const found = parseMessageId(inReplyTo);
    if (found) return found;
  }
  const references = headers['References'] ?? headers['references'];
  if (references) {
    const ids = references.match(/<[^>]+>/g) ?? [];
    for (const id of ids.reverse()) {
      const found = parseMessageId(id);
      if (found) return found;
    }
  }
  return null;
}
