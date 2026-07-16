'use client';

import { Check, Minus, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, Skeleton, cn } from '@/components/ui';
import {
  formatPaise,
  useCancelSubscription,
  useChangeSeats,
  useCheckout,
  usePlans,
  useSubscription,
  type Plan,
} from '@/features/billing/use-billing';
import { useAuthStore } from '@/lib/auth-store';

const STATUS_LABEL: Record<string, string> = {
  TRIALING: 'Free trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment issue',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

/** Human names for the feature keys the API sends. */
const FEATURE_LABELS: Record<string, string> = {
  crm: 'Full CRM — leads, customers, pipeline',
  'ai.insights': 'AI lead scoring & deal forecasting',
  'audit.log': 'Audit trail',
  'reports.export': 'Exports (PDF, Excel, CSV)',
  'auth.sso': 'Google & Microsoft SSO',
};

function PlanCard({
  plan,
  isCurrent,
  canPurchase,
  seatsInUse,
  onChoose,
  pending,
}: {
  plan: Plan;
  isCurrent: boolean;
  canPurchase: boolean;
  seatsInUse: number;
  onChoose: (plan: Plan, seats: number) => void;
  pending: boolean;
}) {
  // Start from whichever is larger: the plan's default, or the people already
  // here. Offering a 3-seat default to a 6-person workspace invites a checkout
  // the API must refuse — a dead end we can simply not build.
  const [seats, setSeats] = useState(Math.max(plan.defaultSeats, seatsInUse, 1));

  const highlight = plan.key === 'GROWTH';

  return (
    <Card
      className={cn(
        'flex flex-col p-5',
        highlight && 'border-accent shadow-[0_0_0_1px_hsl(var(--accent))]',
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{plan.name}</h3>
        {highlight && (
          <span className="inline-flex items-center gap-1 rounded-md bg-accent-subtle px-1.5 py-0.5 text-[11px] font-medium text-accent">
            <Sparkles className="h-3 w-3" />
            Most popular
          </span>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-subtle">{plan.tagline}</p>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight tabular">
          {formatPaise(plan.pricePerSeatMonthly)}
        </span>
        <span className="text-[12px] text-subtle">/ seat / month</span>
      </div>

      <ul className="mt-4 flex-1 space-y-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-[13px]">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            {FEATURE_LABELS[feature] ?? feature}
          </li>
        ))}
      </ul>

      {canPurchase && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span className="text-[13px] text-subtle">Seats</span>
            <span className="inline-flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="Fewer seats"
                disabled={seats <= Math.max(seatsInUse, 1)}
                onClick={() => setSeats((current) => current - 1)}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <span className="w-6 text-center text-sm font-semibold tabular">{seats}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="More seats"
                onClick={() => setSeats((current) => current + 1)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>

          <Button
            className="w-full"
            variant={highlight ? 'primary' : 'secondary'}
            loading={pending}
            disabled={isCurrent}
            onClick={() => onChoose(plan, seats)}
          >
            {isCurrent
              ? 'Current plan'
              : `Subscribe — ${formatPaise(plan.pricePerSeatMonthly * seats)}/mo`}
          </Button>
        </div>
      )}
    </Card>
  );
}

export default function BillingSettingsPage() {
  const can = useAuthStore((state) => state.can);

  const { data: billing, isLoading } = useSubscription();
  const { data: plans } = usePlans();

  const checkout = useCheckout();
  const changeSeats = useChangeSeats();
  const cancel = useCancelSubscription();

  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // Purchasing needs tenant:billing (Owner). Everyone else still sees the page —
  // the rep who notices "3 days left" is how the owner finds out — they just
  // cannot press the buy button for a company that is not theirs to commit.
  const canPurchase = can('tenant:billing');

  if (isLoading || !billing) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }

  const { subscription, entitlements, seatsUsed } = billing;
  const isPaid = subscription.status === 'ACTIVE';
  const trialDays = entitlements.trialDaysRemaining;

  return (
    <div className="space-y-6">
      {/* --- Current state --- */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">
                {subscription.status === 'TRIALING' ? 'Growth trial' : `${subscription.plan} plan`}
              </h2>
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                  isPaid || subscription.status === 'TRIALING'
                    ? 'bg-success/10 text-success'
                    : 'bg-danger/10 text-danger',
                )}
              >
                {STATUS_LABEL[subscription.status] ?? subscription.status}
              </span>
            </div>

            <p className="mt-1 text-[13px] text-subtle">
              {subscription.status === 'TRIALING' && trialDays !== null
                ? trialDays > 0
                  ? `${trialDays} ${trialDays === 1 ? 'day' : 'days'} left — every feature is on, no card on file.`
                  : 'Your trial has ended. Your data is safe; pick a plan below to continue.'
                : isPaid
                  ? `${formatPaise(billing.monthlyTotalPaise)}/month · renews ${
                      subscription.currentPeriodEnd
                        ? new Date(subscription.currentPeriodEnd).toLocaleDateString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })
                        : 'monthly'
                    }`
                  : (entitlements.lockedReason ?? 'Pick a plan below to continue.')}
            </p>
          </div>

          <div className="text-right">
            <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Seats</p>
            <p className="text-lg font-semibold tabular">
              {seatsUsed}
              <span className="text-subtle">/{subscription.seats}</span>
            </p>
          </div>
        </div>

        {/* Seat adjuster, live subscriptions only. Trials get 5 and that's that —
            the number to grow is conversions, not trial size. */}
        {isPaid && canPurchase && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <span className="text-[13px] text-subtle">Change seats:</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={subscription.seats <= seatsUsed}
              loading={changeSeats.isPending}
              onClick={() => changeSeats.mutate(subscription.seats - 1)}
              title={
                subscription.seats <= seatsUsed
                  ? 'Every seat is in use — remove a member first'
                  : undefined
              }
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={changeSeats.isPending}
              onClick={() => changeSeats.mutate(subscription.seats + 1)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[12px] text-subtle">
              Charged pro-rata — add five people mid-month, pay for the half month they're here.
            </span>
          </div>
        )}
      </Card>

      {/* --- The plans --- */}
      {(!isPaid || canPurchase) && plans && (
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.key}
              plan={plan}
              isCurrent={isPaid && subscription.plan === plan.key}
              canPurchase={canPurchase}
              seatsInUse={seatsUsed}
              pending={checkout.isPending}
              onChoose={(chosen, seats) => checkout.mutate({ plan: chosen.key, seats })}
            />
          ))}
        </div>
      )}

      {!canPurchase && (
        <p className="text-[13px] text-subtle">
          Only a workspace owner can change the plan. If the trial is running out, tell them —
          they&apos;ll thank you.
        </p>
      )}

      {/* --- Cancel --- */}
      {isPaid && canPurchase && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-sm font-semibold">Cancel subscription</h2>
            <p className="mt-0.5 text-[13px] text-subtle">
              You keep full access until the period you&apos;ve paid for ends. After that the
              workspace goes read-only — nothing is ever deleted.
            </p>
          </div>

          {confirmingCancel ? (
            <span className="inline-flex items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={cancel.isPending}
                onClick={() => {
                  cancel.mutate();
                  setConfirmingCancel(false);
                }}
              >
                Yes, cancel
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmingCancel(false)}>
                Keep it
              </Button>
            </span>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirmingCancel(true)}>
              Cancel plan
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
