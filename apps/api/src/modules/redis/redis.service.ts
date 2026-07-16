import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfig } from 'src/config/configuration';
import { getTenantId } from 'src/common/context/request-context';

/**
 * Redis wrapper covering the two things we actually use it for: caching
 * expensive reads, and short-lived locks.
 *
 * Every key is prefixed with the tenant id. Cache keys are a classic way to
 * leak across tenants — `cache.get('dashboard:revenue')` looks harmless right
 * up until two workspaces share a process.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService<AppConfig, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null, // required by BullMQ, which shares this config
      lazyConnect: false,
    });

    this.client.on('error', (error) => {
      // Redis being down degrades us (cache misses) but must not take the API
      // down with it, so log and carry on rather than crashing the process.
      this.logger.error(`Redis error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  /** Namespaces a key to the current tenant. */
  private key(rawKey: string): string {
    const tenantId = getTenantId() ?? 'global';
    return `nexora:${tenantId}:${rawKey}`;
  }

  async get<T>(rawKey: string): Promise<T | null> {
    const raw = await this.client.get(this.key(rawKey));
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // A poisoned cache entry should never break a request. Drop it and let
      // the caller recompute.
      this.logger.warn(`Discarding unparseable cache entry for ${rawKey}`);
      await this.del(rawKey);
      return null;
    }
  }

  async set(rawKey: string, value: unknown, ttlSeconds = 300): Promise<void> {
    await this.client.set(this.key(rawKey), JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(rawKey: string): Promise<void> {
    await this.client.del(this.key(rawKey));
  }

  /** Drops every key under a prefix for the current tenant, e.g. after a write. */
  async invalidatePrefix(prefix: string): Promise<void> {
    const pattern = this.key(`${prefix}*`);
    // SCAN rather than KEYS: KEYS blocks the server, which on a shared Redis is
    // everyone's problem, not just ours.
    const stream = this.client.scanStream({ match: pattern, count: 100 });

    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length > 0) {
        await this.client.unlink(...keys);
      }
    }
  }

  /**
   * Read-through cache. Computes and stores on miss.
   *
   * Note this does not stampede-protect: if a hot key expires under load, every
   * concurrent request recomputes. Fine at our current scale; revisit with a
   * lock if a single computation ever gets expensive enough to matter.
   */
  async remember<T>(rawKey: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(rawKey);
    if (cached !== null) return cached;

    const fresh = await compute();
    await this.set(rawKey, fresh, ttlSeconds);
    return fresh;
  }

  async ping(): Promise<boolean> {
    const reply = await this.client.ping();
    return reply === 'PONG';
  }
}
