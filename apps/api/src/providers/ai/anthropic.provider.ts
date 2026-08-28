import { Injectable } from '@nestjs/common';
import { AICompletion, AIProvider } from './ai.provider';

/** Current model. One place, so a migration is one line (§1.7). */
export const ANTHROPIC_MODEL = 'claude-opus-4-5';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// ponytail: plain fetch, no @anthropic-ai/sdk. The Messages API call this needs is one
// POST with three headers; the SDK would be a dependency for JSON.stringify. Add it
// when streaming, tool use or retries-with-backoff are actually needed.
@Injectable()
export class AnthropicProvider implements AIProvider {
  // Fields, not constructor parameters: Nest injects every constructor argument
  // from design:paramtypes, defaults included, and fails to resolve `string`.
  private readonly apiKey = process.env.ANTHROPIC_API_KEY;
  private readonly model = ANTHROPIC_MODEL;

  async complete(params: AICompletion): Promise<string> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens ?? 1024,
        system: params.system,
        messages: [{ role: 'user', content: params.prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`anthropic: ${res.status} ${await res.text().catch(() => '')}`.trim());
    }

    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('anthropic: empty completion');
    return text;
  }
}
