import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import {
  AI_PROVIDERS,
  AiPermanentError,
  AiTransientError,
  type AiCompletionRequest,
  type AiCompletionResponse,
  type AiProvider,
  type AiProviderName,
} from './ai.types';

/** How many times to retry one provider before giving up on it. */
const MAX_ATTEMPTS_PER_PROVIDER = 3;

/** Base backoff. Doubles per attempt, with jitter. */
const BASE_BACKOFF_MS = 500;

/**
 * The only AI entry point feature code should use.
 *
 * Its job is to make model calls *boring*: pick a provider, retry the blips,
 * fail over when a whole vendor is down, and never let an AI outage take a
 * business feature with it.
 *
 * The design rule that matters: **AI is advisory, and its failure is never
 * fatal.** A lead still saves when the scoring model is down — it just saves
 * without a score. Anything that would block a user's actual work on a model
 * being reachable is a bug in the caller, not in this service.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly defaultProvider: AiProviderName;

  /** Only providers that actually have a key. Built once at boot. */
  private readonly available: Map<AiProviderName, AiProvider>;

  constructor(
    @Inject(AI_PROVIDERS) providers: AiProvider[],
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.defaultProvider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true });

    this.available = new Map(
      providers.filter((provider) => provider.isConfigured()).map((p) => [p.name, p]),
    );

    if (this.available.size === 0) {
      // Not fatal. The platform runs fine without AI — the features that use it
      // degrade, and everything else is unaffected. But say so loudly, because
      // silently shipping without AI is a surprise nobody wants in production.
      this.logger.warn(
        'No AI provider is configured. AI features will be skipped. ' +
          'Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to enable them.',
      );
    } else {
      this.logger.log(`AI providers ready: ${[...this.available.keys()].join(', ')}`);
    }
  }

  /** Whether any provider is usable. Callers gate optional AI work on this. */
  isEnabled(): boolean {
    return this.available.size > 0;
  }

  /**
   * Runs a completion, with retries and cross-provider failover.
   *
   * Order of escalation:
   *   1. Try the requested (or default) provider, retrying transient faults
   *      with exponential backoff.
   *   2. If it is still failing, move to the next configured provider.
   *   3. Only when every provider is exhausted do we throw.
   *
   * Permanent errors (bad key, unknown model) skip straight to the next
   * provider — retrying them just wastes a customer's time.
   */
  async complete<T = string>(request: AiCompletionRequest): Promise<AiCompletionResponse<T>> {
    const chain = this.buildProviderChain(request.provider);

    if (chain.length === 0) {
      throw new ServiceUnavailableException('No AI provider is configured.');
    }

    const failures: string[] = [];

    for (const provider of chain) {
      try {
        return await this.completeWithRetries<T>(provider, request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${provider.name}: ${reason}`);

        this.logger.warn(
          `Provider ${provider.name} failed; ` +
            `${chain.indexOf(provider) < chain.length - 1 ? 'failing over' : 'no providers left'}. ` +
            `Reason: ${reason}`,
        );
      }
    }

    throw new ServiceUnavailableException(
      `Every AI provider failed. ${failures.join(' | ')}`,
    );
  }

  /**
   * Best-effort variant: returns null instead of throwing.
   *
   * This is what background enrichment should use — lead scoring, summaries,
   * churn prediction. Those are nice to have, and none of them is worth failing
   * a job over. Returning null lets the caller carry on and try again later.
   */
  async tryComplete<T = string>(
    request: AiCompletionRequest,
  ): Promise<AiCompletionResponse<T> | null> {
    if (!this.isEnabled()) return null;

    try {
      const response = await this.complete<T>(request);

      // A refusal is not an error, but it is not an answer either. Treat it as
      // "no result" so callers don't write an empty string into a database
      // column and call it an insight.
      return response.refused ? null : response;
    } catch (error) {
      this.logger.error(
        `AI completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Retries one provider, backing off between attempts. */
  private async completeWithRetries<T>(
    provider: AiProvider,
    request: AiCompletionRequest,
  ): Promise<AiCompletionResponse<T>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PROVIDER; attempt++) {
      try {
        const started = Date.now();
        const response = await provider.complete<T>(request);

        this.logger.debug(
          `${provider.name}/${response.model} → ${response.usage.inputTokens} in, ` +
            `${response.usage.outputTokens} out, ${Date.now() - started}ms`,
        );

        return response;
      } catch (error) {
        lastError = error;

        // No point retrying a bad key or an unknown model — hand straight over
        // to the next provider.
        if (error instanceof AiPermanentError) throw error;

        if (attempt === MAX_ATTEMPTS_PER_PROVIDER) break;

        await this.sleep(this.backoffMs(attempt, error));
      }
    }

    throw lastError;
  }

  /**
   * Exponential backoff with full jitter.
   *
   * Jitter matters more than it looks: without it, every request that failed in
   * the same second retries in the same later second, and the thundering herd
   * keeps the provider down. Randomising spreads the load out.
   *
   * When the provider told us how long to wait (`retry-after`), we believe it.
   */
  private backoffMs(attempt: number, error: unknown): number {
    if (error instanceof AiTransientError && error.retryAfterSeconds) {
      return error.retryAfterSeconds * 1000;
    }

    const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    return Math.random() * ceiling;
  }

  /**
   * Orders providers: the requested one first, then the rest as fallbacks.
   *
   * Failover is deliberately allowed to cross vendors. A lead score from Gemini
   * is worth far more than no lead score because Anthropic had a bad ten
   * minutes — and it is exactly the scenario the abstraction layer exists for.
   */
  private buildProviderChain(requested?: AiProviderName): AiProvider[] {
    const preferred = requested ?? this.defaultProvider;

    const primary = this.available.get(preferred);
    const fallbacks = [...this.available.values()].filter((p) => p.name !== preferred);

    return primary ? [primary, ...fallbacks] : fallbacks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
