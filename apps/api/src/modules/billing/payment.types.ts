import type { TenantPlan } from '@prisma/client';

/**
 * The vocabulary billing code speaks.
 *
 * Same discipline as the AI layer: feature code states *what it wants*, and an
 * adapter translates that into whatever Razorpay, Stripe or PayPal happen to
 * call it this year. Nothing outside `providers/` may import a vendor SDK.
 *
 * Payments are the place this matters most. A payment provider is the hardest
 * dependency in a SaaS to remove once its concepts have leaked — Razorpay's
 * `subscription_id` ending up in a React component is how a company discovers,
 * two years later, that it cannot sell to Europe without a rewrite.
 */

export interface CreateSubscriptionParams {
  plan: TenantPlan;
  seats: number;
  /** Our tenant id, handed to the provider so its webhooks can be traced home. */
  tenantId: string;
  customer: {
    name: string;
    email: string;
    /** The company, not the person — this is what appears on the invoice. */
    companyName: string;
  };
}

export interface ProviderSubscription {
  /** The provider's id. Stored, and the join key for every webhook after this. */
  id: string;
  customerId: string;
  /**
   * Where to send the user to authorise payment.
   *
   * Razorpay calls this a "short URL", Stripe a "Checkout session URL". Callers
   * do not care, and must not have to.
   */
  checkoutUrl: string;
}

/** A subscription lifecycle event, normalised across providers. */
export type PaymentEventType =
  | 'subscription.activated'
  | 'subscription.charged'
  | 'subscription.payment_failed'
  | 'subscription.cancelled'
  | 'subscription.completed'
  /** Anything we do not model. Recorded, acknowledged, not acted on. */
  | 'unknown';

export interface NormalisedEvent {
  /** The provider's event id. The idempotency key — see WebhookEvent. */
  id: string;
  type: PaymentEventType;
  providerSubscriptionId: string | null;
  /** Paid-through date, when the event carries one. */
  currentPeriodEnd: Date | null;
  raw: unknown;
}

/**
 * What every payment adapter must do.
 *
 * Note `verifyWebhook` is part of the contract rather than an implementation
 * detail. A webhook endpoint is a public, unauthenticated URL that mutates
 * billing state — if an adapter could forget to verify the signature, then
 * anyone on the internet could POST `subscription.charged` and award themselves
 * a free year. It is not optional, so it is in the interface.
 */
export interface PaymentProvider {
  readonly name: string;

  /** True when the provider has the keys it needs to actually work. */
  isConfigured(): boolean;

  createSubscription(params: CreateSubscriptionParams): Promise<ProviderSubscription>;

  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void>;

  /** Changes the seat count on a live subscription. */
  updateSeats(providerSubscriptionId: string, seats: number): Promise<void>;

  /**
   * Verifies a webhook came from the provider and not from an attacker.
   *
   * Takes the **raw body bytes**, not the parsed object. Signatures are computed
   * over exact bytes, and `JSON.parse` followed by `JSON.stringify` does not
   * reliably reproduce them — key order and unicode escaping both drift. Passing
   * a parsed body here is the classic way to end up with a verification function
   * that rejects every legitimate webhook, and then gets "fixed" by deleting it.
   */
  verifyWebhook(rawBody: Buffer, signature: string): boolean;

  parseEvent(payload: unknown): NormalisedEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
