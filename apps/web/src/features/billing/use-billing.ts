'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch, ApiRequestError } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
export type PlanKey = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';

export interface Entitlements {
  canWrite: boolean;
  suspended: boolean;
  features: string[];
  seats: number;
  status: SubscriptionStatus;
  plan: PlanKey;
  trialDaysRemaining: number | null;
  lockedReason: string | null;
}

export interface SubscriptionSummary {
  subscription: {
    id: string;
    plan: PlanKey;
    status: SubscriptionStatus;
    seats: number;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  entitlements: Entitlements;
  /** Active members + pending invitations. What the seat limit checks. */
  seatsUsed: number;
  monthlyTotalPaise: number;
}

export interface Plan {
  key: PlanKey;
  name: string;
  tagline: string;
  /** Per seat, per month, in paise — ₹499 arrives as 49900. */
  pricePerSeatMonthly: number;
  defaultSeats: number;
  features: string[];
}

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => ['billing', 'subscription'] as const,
  plans: () => ['billing', 'plans'] as const,
};

export function useSubscription() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: billingKeys.subscription(),
    queryFn: () => apiFetch<SubscriptionSummary>('/billing/subscription'),
    // The shell's trial banner mounts this on every page. Don't refetch on each
    // navigation — a subscription changes on the scale of days, not clicks.
    staleTime: 60_000,
    enabled: Boolean(accessToken),
  });
}

export function usePlans() {
  return useQuery({
    queryKey: billingKeys.plans(),
    queryFn: () => apiFetch<Plan[]>('/billing/plans'),
    // The pricing catalogue changes when we deploy, not while you browse.
    staleTime: Infinity,
  });
}

/**
 * Starts a paid subscription.
 *
 * On success the browser is *redirected away* to the payment provider's page —
 * so there is deliberately no success toast and no cache invalidation here.
 * Payment is confirmed by a webhook, not by this call returning; the fresh
 * state greets the customer when they come back.
 */
export function useCheckout() {
  return useMutation({
    mutationFn: (input: { plan: PlanKey; seats: number }) =>
      apiFetch<{ checkoutUrl: string }>('/billing/checkout', { method: 'POST', body: input }),

    onSuccess: ({ checkoutUrl }) => {
      window.location.assign(checkoutUrl);
    },

    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : 'Could not start the checkout.',
      );
    },
  });
}

export function useChangeSeats() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (seats: number) =>
      apiFetch('/billing/seats', { method: 'PATCH', body: { seats } }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success('Seat count updated', {
        description: 'The difference is charged pro-rata on your next invoice.',
      });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not change seats.');
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiFetch('/billing/subscription', { method: 'DELETE' }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      // Say what actually happens. "Subscription cancelled" alone reads like the
      // lights just went out, and the support ticket asks why they were charged.
      toast.success('Subscription cancelled', {
        description: 'You keep full access until the end of the period you already paid for.',
      });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not cancel.');
    },
  });
}

/**
 * Recognises the API's "pay up" refusals (402), so callers can route the user
 * to billing instead of showing a dead error toast.
 */
export function isPaymentRequired(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 402;
}

/** ₹ formatting for paise values. `49900` → `₹499`. */
export function formatPaise(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}
