import { Injectable } from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import { RedisService } from 'src/modules/redis/redis.service';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { runCrossTenant } from 'src/common/context/request-context';

export interface ResolvedMembership {
  membershipId: string;
  roleKey: string;
  permissions: string[];
}

const CACHE_TTL_SECONDS = 300;

/**
 * Answers "does this user still have a seat here, and what may they do?" on
 * every authenticated request.
 *
 * Sits on the hot path, so it is cached. But permission changes must take
 * effect *now*, not in five minutes — so the cache is invalidated explicitly
 * whenever a membership or role changes, and the TTL is only a backstop against
 * a missed invalidation. That is the right way round: correctness by
 * invalidation, with expiry as insurance.
 */
@Injectable()
export class MembershipCache {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(userId: string, tenantId: string): Promise<ResolvedMembership | null> {
    const cacheKey = this.cacheKey(userId, tenantId);

    // Not RedisService.remember(): that namespaces keys by the *current* tenant
    // context, which is not yet populated when this runs (we are the thing that
    // populates it). Use the raw client with an explicit global key.
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as ResolvedMembership | { absent: true };
      return 'absent' in parsed ? null : parsed;
    }

    const membership = await this.load(userId, tenantId);

    // Cache the negative too, briefly. Otherwise a revoked user hammering the
    // API turns every one of their 401s into a database round trip.
    await this.redis.client.set(
      cacheKey,
      JSON.stringify(membership ?? { absent: true }),
      'EX',
      membership ? CACHE_TTL_SECONDS : 30,
    );

    return membership;
  }

  /**
   * Called whenever a role's permissions change, a member's role is reassigned,
   * or a member is suspended or removed. Missing a call here is how a fired
   * employee keeps working, so every write path in RbacService and
   * MembershipsService ends with one.
   */
  async invalidate(userId: string, tenantId: string): Promise<void> {
    await this.redis.client.del(this.cacheKey(userId, tenantId));
  }

  /** Drops every cached membership for a tenant — used when a role is edited,
   *  since that can affect many users at once. */
  async invalidateTenant(tenantId: string): Promise<void> {
    const stream = this.redis.client.scanStream({
      match: `nexora:membership:*:${tenantId}`,
      count: 100,
    });

    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length > 0) {
        await this.redis.client.unlink(...keys);
      }
    }
  }

  private async load(userId: string, tenantId: string): Promise<ResolvedMembership | null> {
    // Cross-tenant by necessity: this runs *before* the tenant context exists,
    // and is precisely the query that establishes it. It is safe because both
    // ids come from a signed token, and the compound key means a mismatched
    // pair simply finds nothing.
    const membership = await runCrossTenant(() =>
      this.prisma.membership.findFirst({
        where: {
          userId,
          tenantId,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
          tenant: { deletedAt: null },
          user: { deletedAt: null },
        },
        select: {
          id: true,
          role: { select: { key: true, permissions: true } },
        },
      }),
    );

    if (!membership) return null;

    return {
      membershipId: membership.id,
      roleKey: membership.role.key,
      permissions: membership.role.permissions,
    };
  }

  private cacheKey(userId: string, tenantId: string): string {
    return `nexora:membership:${userId}:${tenantId}`;
  }
}
