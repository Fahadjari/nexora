import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from 'src/config/configuration';
import { createTenantScopeExtension } from './tenant-scope.extension';

/**
 * The raw, *unscoped* Prisma client.
 *
 * Deliberately not the one you inject in feature services. It can read any
 * tenant's rows, so it exists for exactly three jobs: connection lifecycle,
 * health checks, and the handful of genuinely cross-tenant operations (login,
 * which must find a user before we know their workspace; the seeder; platform
 * admin). Feature code injects `TENANT_DB` instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppConfig, true>) {
    const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

    super({
      datasources: {
        db: { url: config.get('DATABASE_URL', { infer: true }) },
      },
      // Warnings and errors always; full query logs only when developing, since
      // query logs in production are both noisy and a way to leak customer data
      // into log storage.
      log: isProduction
        ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
        : [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    await this.$queryRaw`SELECT 1`;
    return true;
  }
}

/**
 * Builds the tenant-scoped client. Kept as a standalone function so its return
 * type can be named — `TenantDb` below is what feature services depend on.
 */
export function withTenantScope(prisma: PrismaClient) {
  return prisma.$extends(createTenantScopeExtension());
}

/**
 * The client every feature service should inject. Identical API to PrismaClient,
 * except that tenant isolation and soft-delete filtering are already applied.
 */
export type TenantDb = ReturnType<typeof withTenantScope>;

/** DI token for `TenantDb`. */
export const TENANT_DB = Symbol('TENANT_DB');
