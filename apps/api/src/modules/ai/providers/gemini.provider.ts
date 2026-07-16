import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
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
 * Google Gemini adapter.
 *
 * The most awkward of the three to normalise, in three ways:
 *
 *   • Roles are `user` / `model` rather than `user` / `assistant`.
 *   • Structured output goes through `responseSchema` with an OpenAPI-flavoured
 *     schema dialect, not JSON Schema — the biggest difference being that it
 *     rejects `additionalProperties`.
 *   • The SDK does not export typed error classes, so failures have to be
 *     classified by HTTP status dug out of the message. That is uglier than the
 *     other two adapters, and it is contained here precisely so it stays out of
 *     everything else.
 */
@Injectable()
export class GeminiProvider implements AiProvider {
  readonly name: AiProviderName = 'gemini';

  private readonly logger = new Logger(GeminiProvider.name);
  private readonly client: GoogleGenerativeAI | null;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const apiKey = this.config.get('GEMINI_API_KEY', { infer: true });
    this.defaultModel = this.config.get('GEMINI_MODEL', { infer: true });

    this.client = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete<T = string>(request: AiCompletionRequest): Promise<AiCompletionResponse<T>> {
    if (!this.client) {
      throw new AiPermanentError('Gemini is not configured.', this.name);
    }

    const modelName = request.model ?? this.defaultModel;

    const model: GenerativeModel = this.client.getGenerativeModel({
      model: modelName,
      ...(request.system ? { systemInstruction: request.system } : {}),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.jsonSchema
          ? {
              responseMimeType: 'application/json',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types
              // its schema as its own OpenAPI dialect; we hand it a sanitised JSON Schema.
              responseSchema: this.toGeminiSchema(request.jsonSchema) as any,
            }
          : {}),
      },
    });

    try {
      const result = await model.generateContent({
        contents: request.messages.map((message) => ({
          // Gemini calls the assistant "model".
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
      });

      const response = result.response;

      // A blocked prompt yields no candidates at all — calling .text() on it
      // throws, so check first.
      if (response.promptFeedback?.blockReason) {
        this.logger.warn(`Gemini blocked a prompt: ${response.promptFeedback.blockReason}`);
        return {
          content: '' as T,
          provider: this.name,
          model: modelName,
          usage: this.readUsage(response),
          refused: true,
        };
      }

      const text = response.text();

      return {
        content: (request.jsonSchema ? JSON.parse(text) : text) as T,
        provider: this.name,
        model: modelName,
        usage: this.readUsage(response),
        refused: false,
      };
    } catch (error) {
      throw this.translateError(error, modelName);
    }
  }

  /**
   * Strips the parts of JSON Schema that Gemini's dialect rejects.
   *
   * Chiefly `additionalProperties`, which it does not accept at all. Sending a
   * schema through unmodified produces an opaque 400, so we prune rather than
   * let the caller find out the hard way.
   */
  private toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const { additionalProperties: _dropped, ...rest } = schema;

    if (rest.type === 'object' && typeof rest.properties === 'object') {
      const properties = rest.properties as Record<string, Record<string, unknown>>;

      return {
        ...rest,
        properties: Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [key, this.toGeminiSchema(value)]),
        ),
      };
    }

    if (rest.type === 'array' && typeof rest.items === 'object') {
      return { ...rest, items: this.toGeminiSchema(rest.items as Record<string, unknown>) };
    }

    return rest;
  }

  private readUsage(response: {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }) {
    return {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  /**
   * Classifies a Gemini failure.
   *
   * The SDK throws plain `Error`s with the HTTP status baked into the message,
   * so unlike the other two adapters we have no typed classes to switch on and
   * must match on the status code. Contained here on purpose.
   */
  private translateError(error: unknown, model: string): Error {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('429') || message.toLowerCase().includes('quota')) {
      return new AiTransientError('Gemini rate limit or quota reached.', this.name);
    }

    if (message.includes('503') || message.includes('500')) {
      return new AiTransientError('Gemini is temporarily unavailable.', this.name);
    }

    if (message.includes('API key') || message.includes('401') || message.includes('403')) {
      return new AiPermanentError('Gemini rejected the API key.', this.name);
    }

    if (message.includes('404')) {
      return new AiPermanentError(`Gemini does not know the model "${model}".`, this.name);
    }

    return new AiPermanentError(`Gemini error: ${message}`, this.name);
  }
}
