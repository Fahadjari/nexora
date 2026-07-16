import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { loadConfiguration, type AppConfig } from './config/configuration';
import { AiModule } from './modules/ai/ai.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { BillingModule } from './modules/billing/billing.module';
import { SubscriptionGuard } from './modules/billing/guards/subscription.guard';
import { CrmModule } from './modules/crm/crm.module';
import { MembersModule } from './modules/members/members.module';
import { HealthController } from './modules/health/health.controller';
import { PrismaModule } from './modules/prisma/prisma.module';
import { RedisModule } from './modules/redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfiguration],
      cache: true,
    }),

    // Rate limiting. A blunt global default; endpoints that need something
    // stricter (login, in particular) override it with @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const url = new URL(config.get('REDIS_URL', { infer: true }));

        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            ...(url.password ? { password: url.password } : {}),
            // BullMQ requires this to be null; it manages its own retries.
            maxRetriesPerRequest: null,
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { count: 100 },
            // Keep failures around — a queue that silently discards its dead
            // letters is a queue you cannot debug.
            removeOnFail: { count: 1000 },
          },
        };
      },
    }),

    PrismaModule,
    RedisModule,
    AiModule,
    AuditModule,
    AuthModule,
    BillingModule,
    MembersModule,
    CrmModule,
  ],
  controllers: [HealthController],
  providers: [
    // CryptoService is not listed here: AuthModule is @Global and already
    // exports it. Providing it twice would build two instances holding the same
    // derived key — harmless today, and exactly the kind of thing that stops
    // being harmless once one of them gets a cache.

    // --- Global guards, in order ---
    // Order matters, and this is the order:
    //   1. throttle  — cheapest possible rejection, before any work
    //   2. authenticate — who are you? (writes the identity into context)
    //   3. subscription — has your company paid? (reads that identity)
    //   4. authorize — may *you* do this specific thing?
    // Subscription sits before permissions on purpose: "your trial expired" is a
    // truer, more useful answer than "forbidden" when both are true, and it is a
    // property of the workspace rather than the person. All of them fail closed —
    // a route with no @Public() is authenticated, and no @BillingExempt() is
    // subject to the lock.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Opens the AsyncLocalStorage scope. Must run before the guards, since the
    // JWT guard writes the resolved identity into it.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
