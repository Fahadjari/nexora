import { SetMetadata } from '@nestjs/common';
import type { Feature } from './plans';

export const BILLING_EXEMPT_KEY = 'billingExempt';
export const REQUIRED_FEATURE_KEY = 'requiredFeature';

/**
 * Exempts a route from the subscription lock.
 *
 * There is exactly one category of route that needs this, and getting it wrong
 * is catastrophic in a way that is easy to miss: **the routes a locked-out
 * customer uses to stop being locked out.**
 *
 * If `POST /billing/checkout` were subject to the lock, then a customer whose
 * trial expired could not subscribe — the payment page would 402. They would be
 * unable to give you money. The lock would have perfectly prevented the sale it
 * exists to force.
 *
 * The same goes for auth (they must be able to log in to pay), health checks,
 * and the webhook (the provider is not a subscriber).
 */
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT_KEY, true);

/**
 * Requires the tenant's plan to include a feature.
 *
 * Distinct from `@RequirePermissions`, and the distinction is worth being precise
 * about, because conflating them produces genuinely confusing products:
 *
 *   • A **permission** answers "may this *person* do this?" — an accountant may
 *     not delete a customer. Failing it is a 403.
 *   • A **feature** answers "did this *company* pay for this?" — nobody at a
 *     Starter workspace gets AI, including the owner. Failing it is a 402, with
 *     an upgrade path.
 *
 * A user who is told "forbidden" when the real answer is "your plan does not
 * include this" will file a support ticket. One who is told "upgrade to Growth"
 * might file an order.
 */
export const RequiresFeature = (feature: Feature) => SetMetadata(REQUIRED_FEATURE_KEY, feature);
