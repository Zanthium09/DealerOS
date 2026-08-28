import { AIProvider } from '../../providers/ai/ai.provider';

/**
 * §6 — "fiddlier than it looks". Heuristics first (Auto-Submitted, X-Autoreply
 * headers, DSN subjects, unsubscribe phrasing); the model is asked only when none of
 * those match. Only HUMAN_REPLY ever moves a dealer to INTERESTED — the failure this
 * guards against is an out-of-office being read as interest.
 */
export type ReplyClassification = 'AUTO_REPLY' | 'BOUNCE' | 'UNSUBSCRIBE_REQUEST' | 'HUMAN_REPLY';

export type InboundEmail = {
  headers: Record<string, string>;
  subject: string;
  body: string;
  fromAddress: string;
};

function h(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

const OOO_SUBJECT = /\b(out of office|automatic reply|autoreply|auto-reply|away from (my )?(desk|office)|on leave|vacation reply)\b/i;
const DSN_SUBJECT = /\b(undeliverable|undelivered mail|delivery status notification|mail delivery failed|returned to sender|failure notice)\b/i;
const UNSUB_PHRASE = /\b(unsubscribe|remove me from|stop (sending|emailing)|opt(\s|-)?out|do not (contact|email) me)\b/i;

/** Header/subject checks only — never the body, so a well-meaning human reply that
 *  happens to say "please remove this typo" cannot be misread as an unsubscribe. The
 *  UNSUB_PHRASE body check runs separately (see classifyReply) since dealers legitimately
 *  ask to be removed from marketing lists in a genuine reply too. */
function classifyByHeaders(email: InboundEmail): ReplyClassification | null {
  const autoSubmitted = h(email.headers, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return 'AUTO_REPLY';
  if (h(email.headers, 'X-Autoreply') || h(email.headers, 'X-Autorespond')) return 'AUTO_REPLY';
  if (h(email.headers, 'X-Auto-Response-Suppress')) return 'AUTO_REPLY';

  const from = email.fromAddress.toLowerCase();
  if (from.startsWith('mailer-daemon@') || from.startsWith('postmaster@')) return 'BOUNCE';

  if (DSN_SUBJECT.test(email.subject)) return 'BOUNCE';
  if (OOO_SUBJECT.test(email.subject)) return 'AUTO_REPLY';

  return null;
}

/**
 * Heuristics first, AI only for what is left ambiguous. On an ambiguous case with no
 * clear signal, the model is asked a single yes/no question; a response the model
 * fails to answer cleanly defaults to AUTO_REPLY rather than HUMAN_REPLY — a missed
 * lead is recoverable, a dormant mailbox wrongly marked INTERESTED is a false signal
 * the sales team acts on (§10.5's reasoning applied to a different kind of mistake).
 */
export async function classifyReply(email: InboundEmail, ai: AIProvider): Promise<ReplyClassification> {
  const byHeader = classifyByHeaders(email);
  if (byHeader) return byHeader;

  if (UNSUB_PHRASE.test(email.body) || UNSUB_PHRASE.test(email.subject)) return 'UNSUBSCRIBE_REQUEST';

  // Still ambiguous: short, generic, or otherwise not caught by a heuristic. Ask the
  // model to pick between exactly two labels — never to draft anything (§1.5 is about
  // outbound; this is a read-only classification of inbound text).
  const answer = await ai.complete({
    system:
      'You classify one inbound email reply to a cold sales outreach message. ' +
      'Answer with exactly one word: HUMAN_REPLY if a real person wrote this reply ' +
      'themselves, or AUTO_REPLY if it looks like an automated/out-of-office response. ' +
      'When unsure, answer AUTO_REPLY.',
    prompt: `Subject: ${email.subject}\n\n${email.body}`,
  });
  return /^\s*HUMAN_REPLY/i.test(answer) ? 'HUMAN_REPLY' : 'AUTO_REPLY';
}
