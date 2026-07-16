import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantPlan } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from 'src/config/configuration';
import { PLANS } from '../plans';
import type {
  CreateSubscriptionParams,
  NormalisedEvent,
  PaymentEventType,
  PaymentProvider,
  ProviderSubscription,
} from '../payment.types';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

/**
 * Razorpay, over plain REST.
 *
 * No SDK. The surface we need is four calls and an HMAC, and Razorpay's official
 * package pulls a dependency tree into a service that touches money — the one
 * place in this codebase where a compromised transitive dependency is worst. The
 * REST API is stable, documented, and this file is shorter than the wrapper
 * would be.
 *
 * Razorpay's subscription model, briefly, because it drives the mapping:
 *
 *   • A *plan* is created once, in their dashboard, with a per-unit price. We
 *     never send an amount — we send a plan id. That means a bug in our code
 *     cannot charge a customer a price we never published.
 *   • `quantity` is the seat count. Per-seat billing is native, not something we
 *     have to compute and re-send.
 *   • The customer authorises with a mandate (UPI AutoPay, card, netbanking) at
 *     `short_url`. India's recurring-payment rules make this mandatory, which is
 *     precisely why Stripe is not the right first adapter for this market.
 */
@Injectable()
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';

  private readonly logger = new Logger(RazorpayProvider.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  /**
   * Opens a subscription and returns somewhere to send the user to pay.
   *
   * Nothing is charged here. The customer authorises a mandate at the returned
   * URL, and Razorpay tells us it worked via `subscription.activated` — so the
   * subscription is NOT marked active on the strength of this call returning.
   * Trusting a checkout redirect is how you hand out free subscriptions to
   * anyone who can hit the back button.
   */
  async createSubscription(params: CreateSubscriptionParams): Promise<ProviderSubscription> {
    this.assertConfigured();

    const planId = this.providerPlanId(params.plan);

    const customer = await this.request<{ id: string }>('POST', '/customers', {
      name: params.customer.companyName,
      email: params.customer.email,
      // Razorpay 400s on a duplicate email unless told not to. A returning
      // customer resubscribing must not be a hard error.
      fail_existing: 0,
    });

    const subscription = await this.request<{ id: string; short_url: string }>(
      'POST',
      '/subscriptions',
      {
        plan_id: planId,
        customer_id: customer.id,
        /** Seats. Razorpay multiplies the plan's per-unit price by this. */
        quantity: params.seats,
        /**
         * Monthly, for ten years. Razorpay demands a finite count — there is no
         * "until cancelled" — so this is the idiom for an open-ended plan.
         */
        total_count: 120,
        customer_notify: 1,
        /**
         * Our tenant id, echoed back on every webhook. Belt and braces: we can
         * already resolve the tenant from `providerSubscriptionId`, but when a
         * webhook arrives that we cannot place, this is what turns a two-hour
         * incident into a one-line lookup.
         */
        notes: { tenantId: params.tenantId },
      },
    );

    return {
      id: subscription.id,
      customerId: customer.id,
      checkoutUrl: subscription.short_url,
    };
  }

  async cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void> {
    this.assertConfigured();

    await this.request('POST', `/subscriptions/${providerSubscriptionId}/cancel`, {
      // 1 = at the end of the paid period, 0 = immediately. They bought the
      // month; they get the month.
      cancel_at_cycle_end: atPeriodEnd ? 1 : 0,
    });
  }

  async updateSeats(providerSubscriptionId: string, seats: number): Promise<void> {
    this.assertConfigured();

    await this.request('PATCH', `/subscriptions/${providerSubscriptionId}`, {
      quantity: seats,
      // Charge the difference now rather than at the next cycle. A customer who
      // adds five seats mid-month has five people using the product; billing
      // them for it next month is a loan we did not agree to make.
      schedule_change_at: 'now',
    });
  }

  /**
   * Verifies the webhook signature.
   *
   * Two details here are the difference between working security and the
   * appearance of it:
   *
   *   1. The HMAC is over the **raw body bytes**. Re-serialising a parsed body
   *      changes key order and unicode escaping, and the signature stops
   *      matching — see the note in payment.types.
   *   2. The comparison is `timingSafeEqual`, not `===`. String equality returns
   *      early at the first differing byte, so how long it takes leaks how much
   *      of the signature was right, and an attacker can walk a forgery out one
   *      byte at a time. It is a real attack, it is cheap to prevent, and the
   *      prevention is this one function call.
   */
  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const secret = this.webhookSecret;

    if (!secret) {
      // Refuse rather than wave it through. An unverifiable webhook endpoint is
      // an unauthenticated, public mutation of billing state — anyone could POST
      // `subscription.charged` and award themselves a free year.
      this.logger.error('RAZORPAY_WEBHOOK_SECRET is not set; refusing every webhook.');
      return false;
    }

    if (!signature) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest();

    let received: Buffer;
    try {
      received = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }

    // timingSafeEqual throws on a length mismatch, which would itself be a leak
    // if it escaped as a 500. Check the length first, and fail the same way.
    if (received.length !== expected.length) return false;

    return timingSafeEqual(expected, received);
  }

  /**
   * Flattens Razorpay's event into our vocabulary.
   *
   * Their payload nests the subscription under
   * `payload.subscription.entity` — a shape nothing outside this file should
   * ever have to know.
   */
  parseEvent(payload: unknown): NormalisedEvent {
    const event = payload as RazorpayWebhook;

    const entity = event?.payload?.subscription?.entity;

    return {
      // Razorpay does not put an event id in the body; it is a header. The
      // controller passes it through as `x-razorpay-event-id`, and falls back to
      // a deterministic key so that idempotency never depends on a header we did
      // not get.
      id: event?.id ?? `${event?.event}:${entity?.id ?? 'unknown'}:${event?.created_at ?? ''}`,
      type: EVENT_MAP[event?.event ?? ''] ?? 'unknown',
      providerSubscriptionId: entity?.id ?? null,
      // Razorpay speaks unix seconds; JavaScript speaks milliseconds. Getting
      // this wrong dates every subscription to January 1970 — and the bug looks
      // like "customers are being expired at random".
      currentPeriodEnd: entity?.current_end ? new Date(entity.current_end * 1000) : null,
      raw: payload,
    };
  }

  // -------------------------------------------------------------------------

  private get keyId(): string | undefined {
    return this.config.get('RAZORPAY_KEY_ID', { infer: true });
  }

  private get keySecret(): string | undefined {
    return this.config.get('RAZORPAY_KEY_SECRET', { infer: true });
  }

  private get webhookSecret(): string | undefined {
    return this.config.get('RAZORPAY_WEBHOOK_SECRET', { infer: true });
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      // A clear, actionable failure. The trial deliberately needs no card, so a
      // developer can run the entire product without Razorpay keys — and only
      // discovers they are missing when they try to take money, which is exactly
      // when they should.
      throw new ServiceUnavailableException(
        'Payments are not configured on this deployment. Set RAZORPAY_KEY_ID and ' +
          'RAZORPAY_KEY_SECRET to accept subscriptions.',
      );
    }
  }

  private providerPlanId(plan: TenantPlan): string {
    const envKey = PLANS[plan].providerPlanIdEnvKey;

    const planId = envKey
      ? this.config.get(envKey as keyof AppConfig, { infer: true })
      : undefined;

    if (!planId || typeof planId !== 'string') {
      throw new ServiceUnavailableException(
        `No Razorpay plan id configured for the ${PLANS[plan].name} plan (${envKey}). ` +
          'Create the plan in the Razorpay dashboard and set the environment variable.',
      );
    }

    return planId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const credentials = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');

    const response = await fetch(`${RAZORPAY_API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      // Logged, but not returned to the caller: a payment provider's error text
      // can echo back internal ids and, on some endpoints, fragments of the
      // request — which for a payments API is not something to spray into an
      // HTTP response.
      this.logger.error(`Razorpay ${method} ${path} failed (${response.status}): ${detail}`);

      throw new ServiceUnavailableException(
        'The payment provider rejected the request. Please try again, or contact support.',
      );
    }

    return (await response.json()) as T;
  }
}

/** Razorpay's event names → ours. Anything unlisted is `unknown` and ignored. */
const EVENT_MAP: Record<string, PaymentEventType> = {
  'subscription.activated': 'subscription.activated',
  'subscription.charged': 'subscription.charged',
  'subscription.pending': 'subscription.payment_failed',
  'subscription.halted': 'subscription.payment_failed',
  'subscription.cancelled': 'subscription.cancelled',
  'subscription.completed': 'subscription.completed',
};

interface RazorpayWebhook {
  id?: string;
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: {
      entity?: {
        id?: string;
        /** Unix **seconds**. */
        current_end?: number;
      };
    };
  };
}
