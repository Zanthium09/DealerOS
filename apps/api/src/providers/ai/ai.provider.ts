// §1.7 — feature code never calls the Anthropic API. It injects AI_PROVIDER.
//
// The interface is deliberately one method. Everything §1.4 cares about (what the
// model is allowed to see, what it is allowed to return) is enforced one layer up in
// core/drafting, because that is where the typed variables live. A provider is a dumb
// text-in/text-out pipe and must stay that way — a provider that "helpfully" formatted
// a number would be a §1.4 violation nobody could see from the call site.
export interface AICompletion {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface AIProvider {
  complete(params: AICompletion): Promise<string>;
}

export const AI_PROVIDER = 'AI_PROVIDER';
