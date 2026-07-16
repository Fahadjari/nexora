import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  SubscriptionStatus,
  TenantPlan,
  TenantStatus,
  type Prisma,
  type Subscription,
} from '@prisma/client';
import { requireTenantId, runCrossTenant } from 'src/common/context/request-context';
import { AuditService } from 'src/modules/audit/audit.service';
import { PrismaService, TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';
import { resolveEntitlements, type Entitlements } from './entitlements';
import type { NormalisedEvent, PaymentProvider } from './payment.types';
import { PAYMENT_PROVIDER } from './payment.types';
import { monthlyTotal, PLANS, TRIAL_DAYS, TRIAL_PLAN, TRIAL_SEATS } from './plans';

const DAY_MS = 86_400_000;

/**
 * The write a webhook transition produces.
 *
 * `status` is required and a concrete enum, which is the whole reason this type
 * exists rather than reusing Prisma's update input — see the note on
 * `transition()`. The rest are the optional fields a given event may touch.
 */
interface SubscriptionTransition {
  status: SubscriptionStatus;
  currentPeriodEnd?: Date | null;
  pastDueSince?: Date | null;
  trialEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

export interface SubscriptionSummary {
  subscription: Subscription;
  entitlements: Entitlements;
  /** Seats currently occupied — active members plus outstanding invitations. */
  seatsUsed: number;
  monthlyTotalPaise: number;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Starts a 14-day trial for a brand-new workspace.
   *
   * Takes a transaction client because it MUST be created in the same
   * transaction as the tenant. A tenant that exists without a subscription is a
   * company that can log in and then be told, by the guard, that it has no
   * subscription — a broken first five seconds, and the one impression a new
   * customer never gets to un-see.
   */
  async startTrial(tx: Prisma.TransactionClient, tenantId: string): Promise<Subscription> {
    return tx.subscription.create({
      data: {
        tenantId,
        plan: TRIAL_PLAN,
        status: SubscriptionStatus.TRIALING,
        seats: TRIAL_SEATS,
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * DAY_MS),
      },
    });
  }

  /** The billing page: what they have, what it costs, how much of it they are using. */
  async current(): Promise<SubscriptionSummary> {
    const tenantId = requireTenantId();
    const subscription = await this.requireSubscription();

    // Seats *used*, which is members plus people who have been offered a seat
    // and not yet accepted. Counting only accepted members would let an owner
    // invite twenty people onto a five-seat plan and have them all land.
    const [members, pendingInvites] = await Promise.all([
      this.db.membership.count({ where: { status: 'ACTIVE' } }),
      this.db.invitation.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      subscription,
      entitlements: await this.entitlements.forTenant(tenantId),
      seatsUsed: members + pendingInvites,
      monthlyTotalPaise: monthlyTotal(subscription.plan, subscription.seats),
    };
  }

  /**
   * Begins a subscription and returns somewhere to pay.
   *
   * Nothing here marks the subscription active. The provider's redirect proves
   * only that the user reached a page — the money is confirmed by a webhook,
   * later, and that is the only thing allowed to flip the status. Trusting the
   * return URL is how a customer gets a free subscription by pressing "back".
   */
  async createCheckout(plan: TenantPlan, seats: number): Promise<{ checkoutUrl: string }> {
    const tenantId = requireTenantId();

    if (!PLANS[plan].purchasable) {
      throw new BadRequestException(`The ${PLANS[plan].name} plan cannot be purchased.`);
    }

    const seatsUsed = await this.seatsInUse();

    if (seats < seatsUsed) {
      // Buying fewer seats than you have people is not a discount, it is a
      // decision about who gets locked out — and it is not one to make silently
      // on the customer's behalf.
      throw new BadRequestException(
        `You have ${seatsUsed} people in this workspace. Remove some, or buy at least ` +
          `${seatsUsed} seats.`,
      );
    }

    const subscription = await this.requireSubscription();

    const tenant = await runCrossTenant(() =>
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, memberships: { where: { status: 'ACTIVE' }, take: 1, select: { user: { select: { email: true, firstName: true, lastName: true } } } } },
      }),
    );

    const owner = tenant.memberships[0]?.user;

    const created = await this.payments.createSubscription({
      plan,
      seats,
      tenantId,
      customer: {
        name: owner ? `${owner.firstName} ${owner.lastName}` : tenant.name,
        email: owner?.email ?? '',
        companyName: tenant.name,
      },
    });

    // Record the *intent*, not the outcome. Status stays TRIALING until the
    // webhook says otherwise — but we store the provider ids now, because the
    // webhook arrives keyed by `providerSubscriptionId` and would be unmatchable
    // without them. That ordering is the whole reason this write exists.
    await this.db.subscription.update({
      where: { id: subscription.id },
      data: {
        plan,
        seats,
        provider: this.payments.name,
        providerCustomerId: created.customerId,
        providerSubscriptionId: created.id,
      },
    });

    await this.entitlements.invalidate(tenantId);

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Subscription',
      resourceId: subscription.id,
      metadata: { checkoutStarted: true, plan, seats },
    });

    return { checkoutUrl: created.checkoutUrl };
  }

  /** Changes the seat count on a live subscription. */
  async changeSeats(seats: number): Promise<Subscription> {
    const tenantId = requireTenantId();
    const subscription = await this.requireSubscription();

    const seatsUsed = await this.seatsInUse();

    if (seats < seatsUsed) {
      throw new BadRequestException(
        `You have ${seatsUsed} people in this workspace. Remove some before dropping to ` +
          `${seats} seats.`,
      );
    }

    if (subscription.providerSubscriptionId) {
      // Tell the provider first. If we updated our row and *then* the provider
      // call failed, we would be giving away seats we do not bill for — the
      // failure mode that costs money rather than merely annoying someone.
      await this.payments.updateSeats(subscription.providerSubscriptionId, seats);
    }

    const updated = await this.db.subscription.update({
      where: { id: subscription.id },
      data: { seats },
    });

    await this.entitlements.invalidate(tenantId);

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Subscription',
      resourceId: subscription.id,
      metadata: { seats, previousSeats: subscription.seats },
    });

    return updated;
  }

  /**
   * Cancels at the end of the paid period.
   *
   * Not immediately. They bought the month, they get the month — cutting access
   * the instant someone clicks "cancel" bills them for time they cannot use and
   * turns a quiet churn into a refund demand and a bad review.
   */
  async cancel(): Promise<Subscription> {
    const tenantId = requireTenantId();
    const subscription = await this.requireSubscription();

    if (subscription.providerSubscriptionId) {
      await this.payments.cancelSubscription(subscription.providerSubscriptionId, true);
    }

    const updated = await this.db.subscription.update({
      where: { id: subscription.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: true,
      },
    });

    await this.entitlements.invalidate(tenantId);

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Subscription',
      resourceId: subscription.id,
      metadata: { cancelled: true, accessUntil: subscription.currentPeriodEnd },
    });

    this.logger.log(`Tenant ${tenantId} cancelled their subscription.`);

    return updated;
  }

  /**
   * Applies a payment event. The **only** path that may mark a subscription paid.
   *
   * Runs cross-tenant on purpose: a webhook arrives from Razorpay with no user,
   * no token and no tenant context — it is identified solely by
   * `providerSubscriptionId`. This is one of the few places in the codebase that
   * legitimately steps outside the tenant scope, and it does so having first
   * verified an HMAC signature over the raw bytes.
   */
  async applyEvent(event: NormalisedEvent): Promise<void> {
    if (!event.providerSubscriptionId) {
      this.logger.warn(`Ignoring ${event.type}: no subscription id on the event.`);
      return;
    }

    await runCrossTenant(async () => {
      const subscription = await this.prisma.subscription.findUnique({
        where: { providerSubscriptionId: event.providerSubscriptionId! },
      });

      if (!subscription) {
        // Real, and not an error: a subscription created in the Razorpay
        // dashboard by hand, or one belonging to a deleted tenant. Log it and
        // acknowledge — retrying forever against a row that will never exist
        // just fills the provider's dead-letter queue.
        this.logger.warn(
          `No subscription matches provider id ${event.providerSubscriptionId}; ignoring.`,
        );
        return;
      }

      const data = this.transition(event, subscription);

      if (!data) return;

      await this.prisma.subscription.update({ where: { id: subscription.id }, data });

      // Keep the denormalised tenant status in step. It is what the platform
      // (and the admin tooling) reads when it wants a one-word answer.
      await this.prisma.tenant.update({
        where: { id: subscription.tenantId },
        data: { status: this.tenantStatusFor(data.status ?? subscription.status) },
      });

      await this.entitlements.invalidate(subscription.tenantId);

      this.logger.log(
        `Tenant ${subscription.tenantId}: ${event.type} → ${data.status ?? subscription.status}`,
      );
    });
  }

  /**
   * The state machine, as a pure decision.
   *
   * Returns the fields to write, or null for "nothing to do".
   *
   * The return type pins `status` to a concrete `SubscriptionStatus` rather than
   * Prisma's `SubscriptionUncheckedUpdateInput`, whose `status` is a *union* with
   * an `{ set: ... }` update-expression object. That union is fine for
   * `.update()`, but useless for `tenantStatusFor(data.status)` — you cannot
   * switch on "either an enum or an update instruction". Narrowing here means the
   * caller gets a real enum, and the compiler enforces that every transition sets
   * one.
   */
  private transition(event: NormalisedEvent, current: Subscription): SubscriptionTransition | null {
    switch (event.type) {
      case 'subscription.activated':
      case 'subscription.charged':
        return {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: event.currentPeriodEnd ?? current.currentPeriodEnd,
          // A successful charge clears the past-due clock. Forgetting this is
          // subtle and vicious: the customer pays, the status goes ACTIVE, but a
          // stale `pastDueSince` means the *next* failure starts its grace period
          // in the past — and locks them out immediately.
          pastDueSince: null,
          trialEndsAt: null,
        };

      case 'subscription.payment_failed':
        // Only start the clock on the *first* failure. Providers retry, and each
        // retry sends another event; resetting `pastDueSince` every time would
        // extend the grace period indefinitely and the account would never lock.
        if (current.status === SubscriptionStatus.PAST_DUE && current.pastDueSince) {
          return null;
        }

        return {
          status: SubscriptionStatus.PAST_DUE,
          pastDueSince: new Date(),
        };

      case 'subscription.cancelled':
      case 'subscription.completed':
        return {
          status: SubscriptionStatus.CANCELLED,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: event.currentPeriodEnd ?? current.currentPeriodEnd,
        };

      case 'unknown':
      default:
        return null;
    }
  }

  /**
   * The periodic sweep.
   *
   * Trials do not expire by themselves. The *guard* already refuses writes the
   * moment `trialEndsAt` passes — enforcement never waits for this job, which is
   * the important safety property. This exists to make the stored status agree
   * with reality, so that reporting, admin screens and dunning emails are not
   * reading a row that still claims to be TRIALING three months later.
   */
  async runMaintenance(now: Date = new Date()): Promise<{ expired: number }> {
    return runCrossTenant(async () => {
      const lapsed = await this.prisma.subscription.findMany({
        where: {
          OR: [
            { status: SubscriptionStatus.TRIALING, trialEndsAt: { lte: now } },
            { status: SubscriptionStatus.CANCELLED, currentPeriodEnd: { lte: now } },
          ],
        },
        select: { id: true, tenantId: true },
      });

      for (const subscription of lapsed) {
        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: { status: SubscriptionStatus.EXPIRED },
        });

        await this.prisma.tenant.update({
          where: { id: subscription.tenantId },
          data: { status: TenantStatus.PAST_DUE },
        });

        await this.entitlements.invalidate(subscription.tenantId);
      }

      if (lapsed.length > 0) {
        this.logger.log(`Expired ${lapsed.length} lapsed subscription(s).`);
      }

      return { expired: lapsed.length };
    });
  }

  /** Seats occupied: active members plus invitations nobody has accepted yet. */
  async seatsInUse(): Promise<number> {
    const [members, invites] = await Promise.all([
      this.db.membership.count({ where: { status: 'ACTIVE' } }),
      this.db.invitation.count({ where: { status: 'PENDING' } }),
    ]);

    return members + invites;
  }

  /** The entitlements of the current tenant. Used by MembersService for seat limits. */
  async currentEntitlements(): Promise<Entitlements> {
    return this.entitlements.forTenant(requireTenantId());
  }

  /**
   * Drops the cached billing state for a tenant.
   *
   * Exposed for MembersService: adding or removing a seat changes "seats used",
   * which the billing summary reports, so the cache has to be dropped or the
   * team page shows a stale count right after an invite lands.
   */
  async invalidateEntitlements(tenantId: string): Promise<void> {
    await this.entitlements.invalidate(tenantId);
  }

  private async requireSubscription(): Promise<Subscription> {
    const subscription = await this.db.subscription.findFirst({});

    if (!subscription) {
      throw new NotFoundException('This workspace has no subscription.');
    }

    return subscription;
  }

  private tenantStatusFor(status: SubscriptionStatus): TenantStatus {
    switch (status) {
      case SubscriptionStatus.ACTIVE:
        return TenantStatus.ACTIVE;
      case SubscriptionStatus.TRIALING:
        return TenantStatus.TRIAL;
      case SubscriptionStatus.PAST_DUE:
      case SubscriptionStatus.EXPIRED:
        return TenantStatus.PAST_DUE;
      case SubscriptionStatus.CANCELLED:
        return TenantStatus.CANCELLED;
      default:
        return TenantStatus.TRIAL;
    }
  }
}

/** Re-exported so callers do not need two imports to read an entitlement. */
export { resolveEntitlements };
