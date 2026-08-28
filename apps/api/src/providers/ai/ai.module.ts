import { Global, Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai.provider';
import { AnthropicProvider } from './anthropic.provider';

// §1.7 — the only way to reach a model. Swapping providers is changing useClass here.
@Global()
@Module({
  providers: [{ provide: AI_PROVIDER, useClass: AnthropicProvider }],
  exports: [AI_PROVIDER],
})
export class AiModule {}
