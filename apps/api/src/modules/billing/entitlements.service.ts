import { Injectable, Logger } from '@nestjs/common';
import { runCrossTenant } from 'src/common/context/request-context';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { RedisService } from 'src/modules/redis/redis.service';
import {
  missingSubscriptionEntitlements,
  resolveEntitlements,
  type BillingState,
  type Entitlements,
} from './entitlements';

/**
 * How long a tenant's billing state is cached.
 *
 * Short, and deliberately so. This sits on the hot path of every request, but a
 * five-minute TTL would also mean a customer who just paid keeps seeing "your
 * trial has expired" for five minutes — which, at the exact moment they have
 * handed over money, is the worst possible time to look broken. So: cache for a
 * minute, and *invalidate explicitly* the instant billing changes. The TTL is a
 * backstop against a missed invalidation, not the mechanism.
 */
const CACHE_TTL_SECONDS = 60;

@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * What this tenant may do right now.
   *
   * Note that the *entitlements* are computed fresh every time, even on a cache
   * hit — only the raw billing state is cached. That is not a micro-optimisation
   * missed; it is required. Entitlements are a function of the clock: a trial
   * expires at a moment in time, and caching the computed answer would keep
   * saying "9 days left" after the trial had ended. Cache the facts, derive the
   * verdict.
   */
  async forTenant(tenantId: string): Promise<Entitlements> {
    const state = await this.billingState(tenantId);

    if (!state) {
      // Registration creates a subscription in the same transaction as the
      // tenant, so this means something is broken. Say so loudly — it will
      // otherwise present as "a customer cannot write and nobody knows why".
      this.logger.error(`Tenant ${tenantId} has no subscription row.`);
      return missingSubscriptionEntitlements();
    }

    return resolveEntitlements(state);
  }

  /** Called by every write in SubscriptionService. Missing one hands out a free product. */
  async invalidate(tenantId: string): Promise<void> {
    await this.redis.client.del(this.cacheKey(tenantId));
  }

  private async billingState(tenantId: string): Promise<BillingState | null> {
    const cached = await this.redis.client.get(this.cacheKey(tenantId));

    if (cached) {
      const parsed = JSON.parse(cached) as SerialisedState | { absent: true };
      return 'absent' in parsed ? null : deserialise(parsed);
    }

    // Cross-tenant by necessity, and safe: this runs inside the auth guard,
    // *before* the tenant context is fully established, and the id comes from a
    // signed token. It is the query that decides what the tenant may do, so it
    // cannot itself be gated on the tenant scope it is about to authorise.
    const subscription = await runCrossTenant(() =>
      this.prisma.subscription.findUnique({
        where: { tenantId },
        select: {
          plan: true,
          status: true,
          seats: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          pastDueSince: true,
          // Pulled through the relation so that "is this company suspended?" and
          // "have they paid?" cost one query and one cache entry, not two.
          tenant: { select: { status: true } },
        },
      }),
    );

    const state: BillingState | null = subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          seats: subscription.seats,
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodEnd: subscription.currentPeriodEnd,
          pastDueSince: subscription.pastDueSince,
          tenantStatus: subscription.tenant.status,
        }
      : null;

    await this.redis.client.set(
      this.cacheKey(tenantId),
      JSON.stringify(state ?? { absent: true }),
      'EX',
      CACHE_TTL_SECONDS,
    );

    return state;
  }

  private cacheKey(tenantId: string): string {
    return `nexora:billing:${tenantId}`;
  }
}

/** Dates survive a round trip through Redis as ISO strings. Put them back. */
interface SerialisedState extends Omit<BillingState, 'trialEndsAt' | 'currentPeriodEnd' | 'pastDueSince'> {
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  pastDueSince: string | null;
}

function deserialise(state: SerialisedState): BillingState {
  return {
    ...state,
    // JSON has no date type. Skipping this leaves strings where the rule expects
    // Dates, and `"2026-07-28T00:00:00Z".getTime()` is not a function — so every
    // trial check would throw, and a fail-open would hand out the product free.
    trialEndsAt: state.trialEndsAt ? new Date(state.trialEndsAt) : null,
    currentPeriodEnd: state.currentPeriodEnd ? new Date(state.currentPeriodEnd) : null,
    pastDueSince: state.pastDueSince ? new Date(state.pastDueSince) : null,
  };
}
