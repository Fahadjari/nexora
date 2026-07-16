import { TenantPlan } from '@prisma/client';

/**
 * What a customer is actually buying.
 *
 * The catalogue lives in code, not in a `plans` table, for the same reason the
 * permission catalogue does: pricing is part of the product, it is reviewed, it
 * ships with a version, and it can be reasoned about offline. A plans table is a
 * production database row that silently changes what the software does — and
 * when someone fat-fingers a price to zero at 2am, there is no diff, no
 * reviewer, and no way to find out who did it.
 *
 * Provider price ids live here too, keyed by plan. Razorpay wants a plan id
 * created in *their* dashboard; we map to it rather than sending raw amounts, so
 * a customer cannot be charged a price we never published.
 */

/**
 * A capability a plan may or may not grant.
 *
 * Deliberately small, and deliberately honest: it lists only things that exist
 * today. A feature flag for a module nobody has written is a lie in a pricing
 * page, and a customer who upgrades to get it has been mis-sold.
 */
export const FEATURES = {
  /** Leads, customers, deals, the pipeline board. The product's floor. */
  CRM: 'crm',
  /** AI lead scoring and deal forecasting. */
  AI_INSIGHTS: 'ai.insights',
  /** The audit trail. */
  AUDIT_LOG: 'audit.log',
  /** PDF/Excel/CSV export. */
  EXPORT: 'reports.export',
  /** Google/Microsoft SSO. */
  SSO: 'auth.sso',
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export interface PlanDefinition {
  key: TenantPlan;
  name: string;
  /** One line, as it appears on the pricing page. */
  tagline: string;
  /**
   * Price per seat, per month, in **paise** — the minor unit.
   *
   * Integers, never floats. `₹499.00` is `49_900`, not `499.0`, because
   * `0.1 + 0.2 !== 0.3` and money that drifts by a paisa per invoice becomes a
   * reconciliation nightmare that someone has to fix by hand. Razorpay's API
   * takes paise for exactly this reason.
   */
  pricePerSeatMonthly: number;
  /** Seats a new subscription starts with. */
  defaultSeats: number;
  features: readonly Feature[];
  /** Whether a customer can actually choose this. FREE cannot — see below. */
  purchasable: boolean;
  /** The provider's id for this plan, from the Razorpay dashboard. */
  providerPlanIdEnvKey?: string;
}

/**
 * The plans.
 *
 * Note what gates AI: the GROWTH tier and up. That is not an arbitrary
 * segmentation — every AI call costs real tokens, so the feature that costs us
 * money per use sits behind the plan that pays for it. A gate that maps to a
 * genuine cost is one you can defend to a customer; a gate invented purely to
 * force an upgrade is one they resent and eventually leave over.
 */
export const PLANS: Record<TenantPlan, PlanDefinition> = {
  /**
   * Not a plan anyone buys. It is where a workspace lands when the trial runs
   * out or a subscription lapses: read-only, no AI, but the data is all still
   * there and can be exported.
   *
   * A lapsed customer keeps their books. Deleting a company's records because
   * their card expired would be indefensible, and no serious business would risk
   * putting their accounting into software that might do it.
   */
  [TenantPlan.FREE]: {
    key: TenantPlan.FREE,
    name: 'Expired',
    tagline: 'Read-only. Your data is safe — subscribe to start writing again.',
    pricePerSeatMonthly: 0,
    defaultSeats: 0,
    features: [FEATURES.EXPORT],
    purchasable: false,
  },

  [TenantPlan.STARTER]: {
    key: TenantPlan.STARTER,
    name: 'Starter',
    tagline: 'Run your sales process. For small teams getting off spreadsheets.',
    pricePerSeatMonthly: 49_900, // ₹499
    defaultSeats: 3,
    features: [FEATURES.CRM, FEATURES.EXPORT],
    purchasable: true,
    providerPlanIdEnvKey: 'RAZORPAY_PLAN_STARTER',
  },

  [TenantPlan.GROWTH]: {
    key: TenantPlan.GROWTH,
    name: 'Growth',
    tagline: 'Everything in Starter, plus the AI that does the work for you.',
    pricePerSeatMonthly: 99_900, // ₹999
    defaultSeats: 5,
    features: [FEATURES.CRM, FEATURES.AI_INSIGHTS, FEATURES.AUDIT_LOG, FEATURES.EXPORT],
    purchasable: true,
    providerPlanIdEnvKey: 'RAZORPAY_PLAN_GROWTH',
  },

  [TenantPlan.ENTERPRISE]: {
    key: TenantPlan.ENTERPRISE,
    name: 'Enterprise',
    tagline: 'For companies that need SSO, controls and a phone number to call.',
    pricePerSeatMonthly: 199_900, // ₹1,999
    defaultSeats: 10,
    features: [
      FEATURES.CRM,
      FEATURES.AI_INSIGHTS,
      FEATURES.AUDIT_LOG,
      FEATURES.EXPORT,
      FEATURES.SSO,
    ],
    purchasable: true,
    providerPlanIdEnvKey: 'RAZORPAY_PLAN_ENTERPRISE',
  },
};

/**
 * What a trial is worth.
 *
 * The trial grants GROWTH, not STARTER. A 14-day trial exists to show a business
 * why the product is worth paying for, and for Nexora that reason is the AI. A
 * trial with the AI switched off demos a competent CRM and converts like one.
 */
export const TRIAL_PLAN: TenantPlan = TenantPlan.GROWTH;
export const TRIAL_DAYS = 14;
export const TRIAL_SEATS = 5;

/**
 * How long a failed payment is tolerated before the workspace goes read-only.
 *
 * Cards expire, banks decline for no reason, and a business whose card bounced
 * on a Friday should not find their sales team locked out on Saturday. Seven
 * days is enough for a human to notice the email and fix it.
 */
export const PAST_DUE_GRACE_DAYS = 7;

/** Plans a customer may actually choose, in the order the pricing page shows them. */
export const PURCHASABLE_PLANS: PlanDefinition[] = [
  PLANS[TenantPlan.STARTER],
  PLANS[TenantPlan.GROWTH],
  PLANS[TenantPlan.ENTERPRISE],
];

export function planFeatures(plan: TenantPlan): readonly Feature[] {
  return PLANS[plan].features;
}

/** Monthly cost of a plan at a given seat count, in paise. */
export function monthlyTotal(plan: TenantPlan, seats: number): number {
  return PLANS[plan].pricePerSeatMonthly * seats;
}

/** Formats paise as rupees for display: `49900` → `₹499`. */
export function formatPaise(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}
