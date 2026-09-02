import { Injectable } from '@nestjs/common';
import { AICompletion, AIProvider } from './ai.provider';

/**
 * NOT flash-lite: as of Aug 2026, gemini-2.5-flash-lite is being wound down ahead of
 * its Oct 2026 retirement and is returning 503s on the live API well before that date
 * — found by actually exercising this provider, not by trusting the model card. Its
 * named replacement, gemini-3.1-flash-lite, is still preview-only with no clearly
 * published rate limit. Plain gemini-2.5-flash is confirmed working today with a
 * published free tier of 250 requests/day, no card on file — still comfortably above
 * this app's own send-throttle ceiling (§6: 20/day warmup rising to a 50/day hard
 * cap), so drafting volume never gets near Google's free limit either way.
 * One place, so a migration is one line (§1.7), same as ANTHROPIC_MODEL.
 */
export const GEMINI_MODEL = 'gemini-2.5-flash';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ponytail: plain fetch, no @google/genai SDK — same reasoning as AnthropicProvider:
// one POST, three things to set (URL, header, body), not worth a dependency for.
@Injectable()
export class GeminiProvider implements AIProvider {
  // Fields, not constructor parameters — Nest tries to inject every constructor
  // argument from design:paramtypes, defaults included, and fails to resolve
  // `string`. AnthropicProvider hit exactly this; same fix here.
  private readonly apiKey = process.env.GEMINI_API_KEY;
  private readonly model = process.env.GEMINI_MODEL || GEMINI_MODEL;

  async complete(params: AICompletion): Promise<string> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set');

    const res = await fetch(`${API_BASE}/${this.model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Gemini accepts the key as a header (x-goog-api-key) or a ?key= query
        // param; the header keeps it out of server logs that record request URLs.
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: params.system }] },
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        generationConfig: {
          maxOutputTokens: params.maxTokens ?? 1024,
          // Gemini 2.5's "thinking" tokens draw from the SAME budget as the visible
          // reply — on some requests thinking eats enough of it that the actual
          // rewritten email gets cut off mid-sentence, with finishReason still
          // "MAX_TOKENS" but *some* content present, so the old check below let it
          // through. This task is a short rewrite, not multi-step reasoning: thinking
          // buys nothing here and only competes with the answer for tokens.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`gemini: ${res.status} ${await res.text().catch(() => '')}`.trim());
    }

    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const candidate = body.candidates?.[0];
    // Any MAX_TOKENS finish is a truncated reply, not a complete one — with or
    // without partial text. A half-written cold email is worse than an outright
    // failure: a failure surfaces, a truncated draft can slip through approval.
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error('gemini: response truncated by the token limit — raise maxTokens');
    }
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('gemini: empty completion');
    return text;
  }
}
