import { AICompletion, AIProvider } from './ai.provider';

/**
 * Deterministic AIProvider for tests and local runs — no key, no network (§13: the
 * money paths get real tests, and a test that needs an API key is a test nobody runs).
 *
 * Default behaviour echoes the skeleton it was given back, which is exactly what a
 * well-behaved model does: keep every {{placeholder}}, add no digits. Pass `reply` to
 * make it hostile instead — see test/drafting for the adversarial cases.
 */
export class FakeAIProvider implements AIProvider {
  readonly calls: AICompletion[] = [];

  constructor(private readonly reply?: string | ((params: AICompletion) => string)) {}

  async complete(params: AICompletion): Promise<string> {
    this.calls.push(params);
    if (typeof this.reply === 'function') return this.reply(params);
    if (typeof this.reply === 'string') return this.reply;
    // The skeleton is the last line of the prompt (drafting.service.ts builds it).
    return params.prompt.slice(params.prompt.lastIndexOf('\n') + 1).trim();
  }
}
