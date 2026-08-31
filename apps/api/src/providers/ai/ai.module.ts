import { Global, Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai.provider';
import { GeminiProvider } from './gemini.provider';

// §1.7 — the only way to reach a model. Swapping providers is changing useClass here.
// AnthropicProvider (anthropic.provider.ts) implements the same interface and is left
// in place, unused — swapping back is this line, nothing else.
@Global()
@Module({
  providers: [{ provide: AI_PROVIDER, useClass: GeminiProvider }],
  exports: [AI_PROVIDER],
})
export class AiModule {}
