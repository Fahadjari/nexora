import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import {
  AiPermanentError,
  AiTransientError,
  type AiCompletionRequest,
  type AiCompletionResponse,
  type AiProvider,
  type AiProviderName,
} from '../ai.types';

/**
 * Anthropic adapter.
 *
 * Three things about the current Claude API shape are load-bearing here, and
 * each one is a trap for a naively-written abstraction layer:
 *
 *   1. `temperature` / `top_p` are REJECTED with a 400 on current models. So we
 *      drop the caller's temperature hint on the floor rather than forwarding
 *      it. This is exactly why `temperature` is documented as a hint in
 *      ai.types.ts — a shared field that 400s on one provider is a landmine.
 *
 *   2. Structured JSON is requested via `output_config.format`, not by the
 *      prompt-and-pray approach of asking the model nicely for JSON. The API
 *      constrains decoding to the schema, so the result parses by construction.
 *
 *   3. A request can come back `stop_reason: 'refusal'` with HTTP 200 and an
 *      EMPTY content array. Code that reaches straight for `content[0].text`
 *      crashes on it. We check `stop_reason` before touching content.
 */
@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name: AiProviderName = 'anthropic';

  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic | null;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const apiKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
    this.defaultModel = this.config.get('ANTHROPIC_MODEL', { infer: true });

    // A provider with no key is simply absent, not broken. The registry skips
    // it, and the router fails over to whatever else is configured.
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete<T = string>(request: AiCompletionRequest): Promise<AiCompletionResponse<T>> {
    if (!this.client) {
      throw new AiPermanentError('Anthropic is not configured.', this.name);
    }

    const model = request.model ?? this.defaultModel;

    try {
      const response = await this.client.messages.create({
        model,
        // Anthropic requires max_tokens. 4096 is a sane ceiling for the
        // structured, short answers this platform asks for (scores, summaries).
        max_tokens: request.maxTokens ?? 4096,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        // Constrained decoding when a schema is supplied — the model cannot
        // return a shape that fails to parse.
        ...(request.jsonSchema
          ? {
              output_config: {
                format: { type: 'json_schema' as const, schema: request.jsonSchema },
              },
            }
          : {}),
        // NOTE: request.temperature is deliberately NOT forwarded. Current
        // Claude models return 400 if it is present. Steer with the prompt.
      });

      // Safety classifiers can decline with a 200 and no content. Check this
      // before indexing into `content`, or we crash on the empty array.
      if (response.stop_reason === 'refusal') {
        this.logger.warn(`Anthropic declined a request on model ${model}.`);
        return {
          content: '' as T,
          provider: this.name,
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
          refused: true,
        };
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content: (request.jsonSchema ? JSON.parse(text) : text) as T,
        provider: this.name,
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        refused: false,
      };
    } catch (error) {
      throw this.translateError(error, model);
    }
  }

  /**
   * Sorts failures into "try again" and "don't bother".
   *
   * Uses the SDK's typed error classes rather than matching on message strings,
   * which change without warning and differ per locale.
   */
  private translateError(error: unknown, model: string): Error {
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(error.headers?.get?.('retry-after') ?? 0);
      return new AiTransientError(
        'Anthropic rate limit reached.',
        this.name,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }

    // 5xx and overload: the request was fine, the service was not.
    if (error instanceof Anthropic.InternalServerError) {
      return new AiTransientError('Anthropic is temporarily unavailable.', this.name);
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return new AiTransientError('Could not reach Anthropic.', this.name);
    }

    if (error instanceof Anthropic.AuthenticationError) {
      // Retrying a bad key just burns time. Fail loudly so it gets fixed.
      return new AiPermanentError('Anthropic rejected the API key.', this.name);
    }

    if (error instanceof Anthropic.NotFoundError) {
      return new AiPermanentError(`Anthropic does not know the model "${model}".`, this.name);
    }

    if (error instanceof Anthropic.APIError) {
      return new AiPermanentError(`Anthropic error (${error.status}): ${error.message}`, this.name);
    }

    // A JSON.parse failure on a schema-constrained response would land here,
    // and genuinely is a bug worth surfacing rather than retrying.
    return new AiPermanentError(
      `Unexpected Anthropic failure: ${error instanceof Error ? error.message : String(error)}`,
      this.name,
    );
  }
}
