import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AI_PROVIDERS } from './ai.types';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { OpenAiProvider } from './providers/openai.provider';

/**
 * Wires the adapters into a list behind the `AI_PROVIDERS` token.
 *
 * Adding a fourth vendor means writing one adapter and adding one line here.
 * No feature code changes — which is the entire point of the abstraction.
 *
 * Global because AI is cross-cutting: CRM, sales, inventory and support all
 * reach for it, and re-importing this in every one of them is noise.
 */
@Global()
@Module({
  providers: [
    AnthropicProvider,
    OpenAiProvider,
    GeminiProvider,
    {
      provide: AI_PROVIDERS,
      inject: [AnthropicProvider, OpenAiProvider, GeminiProvider],
      useFactory: (
        anthropic: AnthropicProvider,
        openai: OpenAiProvider,
        gemini: GeminiProvider,
      ) => [anthropic, openai, gemini],
    },
    AiService,
  ],
  exports: [AiService],
})
export class AiModule {}
