'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { useAuthStore } from '@/lib/auth-store';

/**
 * The auth gate for every signed-in page.
 *
 * `(app)` in the folder name is a *route group* — the parentheses mean it does
 * NOT appear in the URL. So this layout wraps /dashboard and /leads without
 * anyone having to visit "/app/dashboard". It is purely a way to share a layout
 * across a set of routes.
 *
 * The `hasHydrated` gate is the crux. Sequence on a hard refresh:
 *
 *   1. Server renders. No localStorage exists there, so the store is empty.
 *   2. Browser hydrates with that same empty store — it must match, or React
 *      throws a mismatch error.
 *   3. Only THEN does zustand read localStorage and restore the session.
 *
 * Redirect at step 2 and you throw out every logged-in user on every refresh.
 * So we wait for step 3 before deciding anything.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { accessToken, hasHydrated } = useAuthStore();

  useEffect(() => {
    if (hasHydrated && !accessToken) {
      router.replace('/login');
    }
  }, [hasHydrated, accessToken, router]);

  // Before rehydration we genuinely do not know whether the user is signed in.
  // Rendering the shell would flash it at a signed-out user; rendering the login
  // page would flash it at a signed-in one. So: render nothing, briefly.
  if (!hasHydrated || !accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
