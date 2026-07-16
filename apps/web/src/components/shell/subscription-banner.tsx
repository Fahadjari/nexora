'use client';

import { Clock, Lock } from 'lucide-react';
import Link from 'next/link';
import { useSubscription } from '@/features/billing/use-billing';
import { useAuthStore } from '@/lib/auth-store';
import { cn } from '@/components/ui';

/**
 * The one strip of the UI that talks about money.
 *
 * Three states, in escalating volume:
 *
 *   • Trial, plenty of time left  → nothing. A countdown on day 1 of 14 is
 *     nagging, and nagging teaches people to stop reading the banner — which
 *     wastes the one moment it matters.
 *   • Trial, ≤ 5 days left        → a quiet amber strip with the count and the
 *     one action that matters.
 *   • Locked (expired / past due) → an unmissable strip explaining exactly what
 *     still works (everything, read-only) and how to unlock. This renders on
 *     every page, because the user will hit the lock on every page.
 *
 * The upgrade link is shown to everyone, but leads to a page where the API
 * enforces `tenant:billing` on the actual purchase. A sales rep seeing "trial
 * ends in 3 days" is a feature — they are the ones who will tell the owner.
 */
export function SubscriptionBanner() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const { data } = useSubscription();

  if (!accessToken || !data) return null;

  const { entitlements } = data;

  // Hard lock: trial over, payment failed past grace, or cancelled and lapsed.
  if (!entitlements.canWrite) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-danger/20 bg-danger/10 px-4 py-2 text-center text-[13px]"
      >
        <Lock className="h-3.5 w-3.5 shrink-0 text-danger" />
        <span className="text-foreground">
          {entitlements.lockedReason ?? 'A subscription is needed to make changes.'}
        </span>
        <Link
          href="/settings/billing"
          className="font-semibold text-danger underline-offset-2 hover:underline"
        >
          Choose a plan →
        </Link>
      </div>
    );
  }

  // Trial winding down. Five days is when "later" has to become "now".
  const days = entitlements.trialDaysRemaining;

  if (entitlements.status === 'TRIALING' && days !== null && days <= 5) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-4 py-2 text-center text-[13px]',
          'border-warning/20 bg-warning/10',
        )}
      >
        <Clock className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span>
          {days === 0
            ? 'Your trial ends today.'
            : `Your trial ends in ${days} ${days === 1 ? 'day' : 'days'}.`}{' '}
          Keep the AI working for you.
        </span>
        <Link
          href="/settings/billing"
          className="font-semibold text-warning underline-offset-2 hover:underline"
        >
          Choose a plan →
        </Link>
      </div>
    );
  }

  return null;
}
