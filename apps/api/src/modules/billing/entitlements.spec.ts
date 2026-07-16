import { SubscriptionStatus, TenantPlan, TenantStatus } from '@prisma/client';
import { resolveEntitlements, type BillingState } from './entitlements';
import { FEATURES, PAST_DUE_GRACE_DAYS } from './plans';

/**
 * These rules decide whether a paying customer can use the product they paid
 * for, and whether a non-paying one can use it for free. Both directions cost
 * real money to get wrong, and neither failure is loud:
 *
 *   • Lock out a paying customer and you learn about it from a furious support
 *     ticket, hours later.
 *   • Fail to lock out an expired trial and you learn about it never. The
 *     product is simply free, and revenue is quietly a fraction of what it
 *     should be.
 *
 * `resolveEntitlements` is a pure function of (state, now), which is what lets
 * these tests assert "the trial expires on day 15" without waiting a fortnight.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-07-14T12:00:00Z');

function state(overrides: Partial<BillingState> = {}): BillingState {
  return {
    plan: TenantPlan.GROWTH,
    status: SubscriptionStatus.TRIALING,
    seats: 5,
    trialEndsAt: new Date(NOW.getTime() + 9 * DAY),
    currentPeriodEnd: null,
    pastDueSince: null,
    tenantStatus: TenantStatus.TRIAL,
    ...overrides,
  };
}

describe('resolveEntitlements', () => {
  describe('the trial', () => {
    it('grants full access, with AI, while it is running', () => {
      const result = resolveEntitlements(state(), NOW);

      expect(result.canWrite).toBe(true);
      // The trial exists to show why the product is worth paying for, and for
      // Nexora that reason is the AI. A trial with AI off demos a competent CRM
      // and converts like one.
      expect(result.features).toContain(FEATURES.AI_INSIGHTS);
      expect(result.trialDaysRemaining).toBe(9);
    });

    it('locks writes the moment it expires', () => {
      const expired = state({ trialEndsAt: new Date(NOW.getTime() - 1000) });
      const result = resolveEntitlements(expired, NOW);

      expect(result.canWrite).toBe(false);
      expect(result.trialDaysRemaining).toBe(0);
      expect(result.lockedReason).toMatch(/trial has ended/i);
    });

    it('never takes the data away, even when locked', () => {
      const expired = state({ trialEndsAt: new Date(NOW.getTime() - 30 * DAY) });
      const result = resolveEntitlements(expired, NOW);

      // The company must always be able to get its own records out. A vendor
      // that holds a business's books hostage over an unpaid invoice earns a
      // chargeback and a lawsuit — and deserves both.
      expect(result.features).toContain(FEATURES.EXPORT);
      expect(result.lockedReason).toMatch(/data is safe/i);
    });

    it('is still live on its final day', () => {
      // Off-by-one here is not academic: it either cuts a trial a day short — at
      // the exact moment a prospect is deciding — or hands out a free day to
      // every tenant that ever signs up.
      const lastDay = state({ trialEndsAt: new Date(NOW.getTime() + 1000) });

      expect(resolveEntitlements(lastDay, NOW).canWrite).toBe(true);
    });
  });

  describe('a failed payment', () => {
    it('keeps a past-due customer working during the grace period', () => {
      const pastDue = state({
        status: SubscriptionStatus.PAST_DUE,
        pastDueSince: new Date(NOW.getTime() - 2 * DAY),
        trialEndsAt: null,
      });

      const result = resolveEntitlements(pastDue, NOW);

      // Cards expire and banks decline for no reason. Cutting a paying business
      // off the afternoon their card bounced is how you lose a customer who
      // would happily have paid.
      expect(result.canWrite).toBe(true);
      expect(result.features).toContain(FEATURES.AI_INSIGHTS);
    });

    it('locks once the grace period runs out', () => {
      const pastDue = state({
        status: SubscriptionStatus.PAST_DUE,
        pastDueSince: new Date(NOW.getTime() - (PAST_DUE_GRACE_DAYS + 1) * DAY),
        trialEndsAt: null,
      });

      const result = resolveEntitlements(pastDue, NOW);

      expect(result.canWrite).toBe(false);
      expect(result.lockedReason).toMatch(/could not take payment/i);
    });
  });

  describe('cancellation', () => {
    it('honours the period they already paid for', () => {
      const cancelled = state({
        status: SubscriptionStatus.CANCELLED,
        currentPeriodEnd: new Date(NOW.getTime() + 12 * DAY),
        trialEndsAt: null,
      });

      // They bought the month; they get the month. Cutting access the instant
      // someone clicks "cancel" bills them for time they cannot use, which is
      // the fastest way to turn a quiet churn into a refund demand.
      expect(resolveEntitlements(cancelled, NOW).canWrite).toBe(true);
    });

    it('locks once the paid period has ended', () => {
      const cancelled = state({
        status: SubscriptionStatus.CANCELLED,
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
        trialEndsAt: null,
      });

      expect(resolveEntitlements(cancelled, NOW).canWrite).toBe(false);
    });
  });

  describe('plan features', () => {
    it('withholds AI from a Starter subscription', () => {
      const starter = state({
        plan: TenantPlan.STARTER,
        status: SubscriptionStatus.ACTIVE,
        trialEndsAt: null,
      });

      const result = resolveEntitlements(starter, NOW);

      // Every AI call costs real tokens, so the feature that costs us money per
      // use sits behind the plan that pays for it.
      expect(result.canWrite).toBe(true);
      expect(result.features).toContain(FEATURES.CRM);
      expect(result.features).not.toContain(FEATURES.AI_INSIGHTS);
    });

    it('grants AI on Growth', () => {
      const growth = state({ status: SubscriptionStatus.ACTIVE, trialEndsAt: null });

      expect(resolveEntitlements(growth, NOW).features).toContain(FEATURES.AI_INSIGHTS);
    });
  });

  describe('suspension', () => {
    it('outranks a perfectly healthy subscription', () => {
      // A company suspended for fraud does not get to keep writing just because
      // its card is in good standing.
      const suspended = state({
        status: SubscriptionStatus.ACTIVE,
        trialEndsAt: null,
        tenantStatus: TenantStatus.SUSPENDED,
      });

      const result = resolveEntitlements(suspended, NOW);

      expect(result.canWrite).toBe(false);
      // Flagged separately so the guard answers 403-and-call-us rather than
      // 402-and-here-is-a-payment-button.
      expect(result.suspended).toBe(true);
    });

    it('does not flag an ordinary expired trial as suspended', () => {
      const expired = state({ trialEndsAt: new Date(NOW.getTime() - 1 * DAY) });

      const result = resolveEntitlements(expired, NOW);

      expect(result.canWrite).toBe(false);
      expect(result.suspended).toBe(false);
    });
  });
});
