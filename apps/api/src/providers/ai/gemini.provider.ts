import { Injectable } from '@nestjs/common';
import { AICompletion, AIProvider } from './ai.provider';

/**
 * Free tier as of 2026: Flash-Lite gives 1,000 requests/day with no card on file —
 * comfortably above this app's own send-throttle ceiling (§6: 20/day warmup rising
 * to a 50/day hard cap), so drafting volume never gets near Google's free limit.
 * One place, so a migration is one line (§1.7), same as ANTHROPIC_MODEL.
 */
export const GEMINI_MODEL = 'gemini-2.5-flash-lite';

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
        generationConfig: { maxOutputTokens: params.maxTokens ?? 1024 },
      }),
    });

    if (!res.ok) {
      throw new Error(`gemini: ${res.status} ${await res.text().catch(() => '')}`.trim());
    }

    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const candidate = body.candidates?.[0];
    // MAX_TOKENS with no text back means the reply was cut off before any content —
    // worth a distinct message, since "empty completion" alone would send someone
    // hunting for the wrong bug (a bad prompt) instead of the right one (raise
    // maxTokens).
    if (candidate?.finishReason === 'MAX_TOKENS' && !candidate.content?.parts?.length) {
      throw new Error('gemini: response truncated before any content — raise maxTokens');
    }
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('gemini: empty completion');
    return text;
  }
}
