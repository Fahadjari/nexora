import { SubscriptionStatus, TenantPlan, TenantStatus } from '@prisma/client';
import { PAST_DUE_GRACE_DAYS, planFeatures, TRIAL_PLAN, type Feature } from './plans';

/**
 * The billing facts the entitlement rule needs. A structural subset of the
 * Subscription row, so the rule can be tested with plain objects.
 */
export interface BillingState {
  plan: TenantPlan;
  status: SubscriptionStatus;
  seats: number;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  pastDueSince: Date | null;
  /**
   * The *platform's* view of the company, as opposed to the subscription's.
   *
   * Carried alongside the billing state so the hot path resolves both from one
   * cached read. Without it the guard would hit Postgres on every write to ask
   * "is this company suspended?" — a question whose answer changes maybe once in
   * the life of a tenant.
   */
  tenantStatus: TenantStatus;
}

/** What a tenant may do, right now. */
export interface Entitlements {
  /**
   * The whole enforcement model in one boolean.
   *
   * False means the workspace is read-only: GETs work, writes are refused with
   * 402. It never means the data is gone, hidden, or unexportable — see the note
   * on the lock below.
   */
  canWrite: boolean;
  /**
   * Suspended by us, rather than lapsed by them.
   *
   * Kept separate from `canWrite` because the two deserve different answers: a
   * lapsed subscription is a 402 and an upgrade button, while a suspension is a
   * 403 and a phone call. Collapsing them would offer a fraudster a "Subscribe"
   * button, and tell a customer whose card bounced to contact the abuse team.
   */
  suspended: boolean;
  features: readonly Feature[];
  seats: number;
  status: SubscriptionStatus;
  plan: TenantPlan;
  /** Days left in the trial. Null when not trialing. Floors at 0. */
  trialDaysRemaining: number | null;
  /** Why writing is blocked, in words a business owner can act on. Null if fine. */
  lockedReason: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Decides what a tenant is entitled to.
 *
 * A pure function of (billing state, now). No database, no clock of its own —
 * which is what lets the tests assert "the trial expires on day 15" without
 * waiting a fortnight, and what makes this rule reviewable as a single page.
 *
 * The lock this produces is deliberately a *read-only* lock, never a blackout:
 *
 *   • They can still read every record, and still export.
 *   • They can still reach billing, so they can pay and get unstuck.
 *   • They simply cannot write new business data until they subscribe.
 *
 * Locking a company out of its own books over an expired card is how a vendor
 * earns a chargeback and a lawsuit — and no serious business would put their
 * accounting into software that might do it. The read-only lock is commercially
 * effective (an ERP you cannot write to is useless within a day) without ever
 * holding the customer's data hostage.
 */
export function resolveEntitlements(state: BillingState, now: Date = new Date()): Entitlements {
  const base = {
    seats: state.seats,
    status: state.status,
    plan: state.plan,
    trialDaysRemaining: null as number | null,
    suspended: false,
  };

  // Suspension outranks everything. A company we have suspended for fraud does
  // not get to write just because its card is in good standing.
  if (isSuspended(state.tenantStatus)) {
    return {
      ...base,
      suspended: true,
      canWrite: false,
      features: planFeatures(TenantPlan.FREE),
      lockedReason:
        'This workspace has been suspended. Please contact support — your data is safe.',
    };
  }

  switch (state.status) {
    case SubscriptionStatus.TRIALING: {
      const expired = state.trialEndsAt !== null && state.trialEndsAt.getTime() <= now.getTime();

      if (expired) {
        return {
          ...base,
          // Trial plan, not the FREE plan's features — but it does not matter,
          // because canWrite is false. Stated explicitly so a future reader does
          // not "fix" it into granting AI to a lapsed trial.
          features: planFeatures(TenantPlan.FREE),
          canWrite: false,
          trialDaysRemaining: 0,
          lockedReason:
            'Your free trial has ended. Your data is safe and you can still read and ' +
            'export everything — subscribe to start adding new records again.',
        };
      }

      return {
        ...base,
        // A trial shows off the tier worth buying, not the cheapest one.
        features: planFeatures(TRIAL_PLAN),
        canWrite: true,
        trialDaysRemaining: daysUntil(state.trialEndsAt, now),
        lockedReason: null,
      };
    }

    case SubscriptionStatus.ACTIVE:
      return {
        ...base,
        features: planFeatures(state.plan),
        canWrite: true,
        lockedReason: null,
      };

    case SubscriptionStatus.PAST_DUE: {
      // A failed payment is not yet a lost customer. Cards expire; banks decline
      // for no reason at all. Cut a paying business off the same afternoon their
      // card bounced and you will lose one that would happily have paid.
      const graceEnds = state.pastDueSince
        ? new Date(state.pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS)
        : null;

      const withinGrace = graceEnds === null || graceEnds.getTime() > now.getTime();

      if (withinGrace) {
        return {
          ...base,
          features: planFeatures(state.plan),
          canWrite: true,
          lockedReason: null,
        };
      }

      return {
        ...base,
        features: planFeatures(TenantPlan.FREE),
        canWrite: false,
        lockedReason:
          'We could not take payment, and the grace period has ended. Update your ' +
          'payment method to unlock your workspace — nothing has been deleted.',
      };
    }

    case SubscriptionStatus.CANCELLED: {
      // Cancelled but paid up. They bought the month; they get the month.
      // Cutting access at the moment someone clicks "cancel" bills them for time
      // they cannot use, and it is the single fastest way to earn a refund
      // demand.
      const stillPaid =
        state.currentPeriodEnd !== null && state.currentPeriodEnd.getTime() > now.getTime();

      if (stillPaid) {
        return {
          ...base,
          features: planFeatures(state.plan),
          canWrite: true,
          lockedReason: null,
        };
      }

      return {
        ...base,
        features: planFeatures(TenantPlan.FREE),
        canWrite: false,
        lockedReason:
          'Your subscription has ended. Your data is safe and still exportable — ' +
          'resubscribe whenever you are ready.',
      };
    }

    case SubscriptionStatus.EXPIRED:
    default:
      return {
        ...base,
        features: planFeatures(TenantPlan.FREE),
        canWrite: false,
        lockedReason:
          'Your subscription has ended. Your data is safe and still exportable — ' +
          'resubscribe to start writing again.',
      };
  }
}

/**
 * A tenant with no subscription row at all.
 *
 * Should not happen — registration creates one in the same transaction as the
 * tenant. But "should not happen" is not a security posture, and the honest
 * question is which way to fail.
 *
 * We fail *open* on reads and *closed* on writes: a billing bug must never lock
 * a paying customer out of their own data, and it must never silently hand out a
 * free product either. It also screams in the logs, because this state means
 * something is broken.
 */
export function missingSubscriptionEntitlements(): Entitlements {
  return {
    canWrite: false,
    suspended: false,
    features: planFeatures(TenantPlan.FREE),
    seats: 0,
    status: SubscriptionStatus.EXPIRED,
    plan: TenantPlan.FREE,
    trialDaysRemaining: null,
    lockedReason:
      'We could not find a subscription for this workspace. Please contact support — ' +
      'your data is safe.',
  };
}

/**
 * A tenant the platform has suspended (fraud, abuse, non-payment escalation).
 *
 * Distinct from an expired subscription, and much harsher: suspension is *our*
 * decision about *them*, not a lapsed card. It still is not a data blackout —
 * even a suspended company can read and export what is theirs.
 */
export function isSuspended(tenantStatus: TenantStatus): boolean {
  return tenantStatus === TenantStatus.SUSPENDED || tenantStatus === TenantStatus.CANCELLED;
}

/** Whole days from `now` until `date`, floored at 0. Null in, null out. */
function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;

  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}
