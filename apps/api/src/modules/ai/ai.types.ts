/**
 * The provider-agnostic AI contract.
 *
 * Nexora must never be married to one model vendor: prices move, models get
 * retired, and a customer in a regulated industry may insist on a specific
 * provider. So feature code speaks only this vocabulary, and the adapters in
 * `providers/` translate it.
 *
 * The hard part of a layer like this is not the happy path — it is the places
 * where providers genuinely disagree. Two of those disagreements are encoded
 * directly in the types below, because pretending they don't exist is how these
 * abstractions rot:
 *
 *   • Sampling parameters are NOT universal. Anthropic's current models reject
 *     `temperature`/`top_p` outright with a 400. So `temperature` here is a
 *     *hint*: a provider that cannot honour it drops it rather than failing.
 *     A shared field that silently breaks one provider would be worse than no
 *     field at all.
 *
 *   • Structured output is spelled three different ways (Anthropic's
 *     `output_config.format`, OpenAI's `response_format`, Gemini's
 *     `responseSchema`). We express intent — "return JSON matching this
 *     schema" — and let each adapter reach for its own mechanism.
 */

export type AiProviderName = 'anthropic' | 'openai' | 'gemini';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A JSON Schema describing the expected shape of a structured response. */
export type JsonSchema = Record<string, unknown>;

export interface AiCompletionRequest {
  /** Instructions that frame the task. Kept separate from the conversation
   *  because every provider treats the system prompt differently. */
  system?: string;

  messages: AiMessage[];

  /** Hard ceiling on output length. Honoured by every provider. */
  maxTokens?: number;

  /**
   * Sampling temperature, 0–1. A *hint*, not a guarantee — see the note above.
   * Adapters that cannot accept it will ignore it rather than error.
   */
  temperature?: number;

  /**
   * Ask for JSON matching this schema. When set, `complete()` returns parsed,
   * validated output rather than prose.
   */
  jsonSchema?: JsonSchema;

  /** Overrides the configured model for one call — e.g. a cheap model for a
   *  high-volume classification job. */
  model?: string;

  /** Overrides the default provider for one call. */
  provider?: AiProviderName;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiCompletionResponse<T = string> {
  /** The model's answer: a string normally, or the parsed object when a
   *  `jsonSchema` was supplied. */
  content: T;

  /** Which provider and model actually served this — recorded on AI-written
   *  rows so we can tell later *what* produced a given score. */
  provider: AiProviderName;
  model: string;

  usage: AiUsage;

  /** True when the provider declined on safety grounds rather than answering.
   *  Callers must check this before trusting `content`. */
  refused: boolean;
}

/**
 * The interface every adapter implements.
 *
 * Kept deliberately small. A wide interface would force each adapter to
 * pretend it supports capabilities it doesn't; a narrow one lets the awkward
 * differences stay inside the adapter, where they belong.
 */
export interface AiProvider {
  readonly name: AiProviderName;

  /** False when no API key is configured — such providers are never registered. */
  isConfigured(): boolean;

  complete<T = string>(request: AiCompletionRequest): Promise<AiCompletionResponse<T>>;
}

/** DI token for the set of registered providers. */
export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

/**
 * Thrown when a provider fails in a way that is worth retrying (rate limits,
 * overload, transient network faults). The router uses this to decide between
 * backing off and failing over.
 */
export class AiTransientError extends Error {
  constructor(
    message: string,
    readonly provider: AiProviderName,
    /** Seconds the provider asked us to wait, when it said so. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AiTransientError';
  }
}

/** Thrown when retrying is pointless — a bad request, a bad key, a bad model. */
export class AiPermanentError extends Error {
  constructor(
    message: string,
    readonly provider: AiProviderName,
  ) {
    super(message);
    this.name = 'AiPermanentError';
  }
}
