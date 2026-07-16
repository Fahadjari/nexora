import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
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
 * OpenAI adapter.
 *
 * Differs from Anthropic in the two ways the contract anticipated:
 *
 *   • `temperature` IS accepted here, so we forward the caller's hint.
 *   • Structured output uses `response_format: { type: 'json_schema' }`, and
 *     OpenAI insists the schema be "strict" — every property required, and
 *     `additionalProperties: false`. A schema written for Anthropic will be
 *     rejected unless we normalise it, which `toStrictSchema` does.
 */
@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly name: AiProviderName = 'openai';

  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly client: OpenAI | null;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const apiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    this.defaultModel = this.config.get('OPENAI_MODEL', { infer: true });

    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete<T = string>(request: AiCompletionRequest): Promise<AiCompletionResponse<T>> {
    if (!this.client) {
      throw new AiPermanentError('OpenAI is not configured.', this.name);
    }

    const model = request.model ?? this.defaultModel;

    // OpenAI folds the system prompt into the message list rather than taking
    // it as a separate field.
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.jsonSchema
          ? {
              response_format: {
                type: 'json_schema' as const,
                json_schema: {
                  name: 'response',
                  strict: true,
                  schema: this.toStrictSchema(request.jsonSchema),
                },
              },
            }
          : {}),
      });

      const choice = response.choices[0];

      // OpenAI signals a safety stop through finish_reason rather than an error.
      if (choice?.finish_reason === 'content_filter') {
        return {
          content: '' as T,
          provider: this.name,
          model: response.model,
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
          },
          refused: true,
        };
      }

      const text = choice?.message?.content ?? '';

      return {
        content: (request.jsonSchema ? JSON.parse(text) : text) as T,
        provider: this.name,
        model: response.model,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        refused: false,
      };
    } catch (error) {
      throw this.translateError(error, model);
    }
  }

  /**
   * Rewrites a schema to satisfy OpenAI's strict mode.
   *
   * Strict mode demands that every object list *all* of its properties in
   * `required` and set `additionalProperties: false`. Our schemas are written
   * to the plain JSON Schema spec, where `required` means what it says. Rather
   * than force every caller to write OpenAI-flavoured schemas — which would
   * leak this provider's quirk into the whole codebase — we adapt here.
   */
  private toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (schema.type !== 'object' || typeof schema.properties !== 'object') {
      return schema;
    }

    const properties = schema.properties as Record<string, Record<string, unknown>>;

    return {
      ...schema,
      additionalProperties: false,
      required: Object.keys(properties),
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, this.toStrictSchema(value)]),
      ),
    };
  }

  private translateError(error: unknown, model: string): Error {
    if (error instanceof OpenAI.RateLimitError) {
      return new AiTransientError('OpenAI rate limit reached.', this.name);
    }

    if (error instanceof OpenAI.InternalServerError) {
      return new AiTransientError('OpenAI is temporarily unavailable.', this.name);
    }

    if (error instanceof OpenAI.APIConnectionError) {
      return new AiTransientError('Could not reach OpenAI.', this.name);
    }

    if (error instanceof OpenAI.AuthenticationError) {
      return new AiPermanentError('OpenAI rejected the API key.', this.name);
    }

    if (error instanceof OpenAI.NotFoundError) {
      return new AiPermanentError(`OpenAI does not know the model "${model}".`, this.name);
    }

    if (error instanceof OpenAI.APIError) {
      return new AiPermanentError(`OpenAI error (${error.status}): ${error.message}`, this.name);
    }

    return new AiPermanentError(
      `Unexpected OpenAI failure: ${error instanceof Error ? error.message : String(error)}`,
      this.name,
    );
  }
}
