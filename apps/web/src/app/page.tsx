'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuthStore } from '@/lib/auth-store';

/**
 * The root route. Just a signpost: send people where they belong.
 *
 * Waits for rehydration before deciding — otherwise a signed-in user hitting "/"
 * is bounced to /login before the store has finished loading their session.
 */
export default function RootPage() {
  const router = useRouter();
  const { accessToken, hasHydrated } = useAuthStore();

  useEffect(() => {
    if (!hasHydrated) return;
    router.replace(accessToken ? '/dashboard' : '/login');
  }, [hasHydrated, accessToken, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
    </div>
  );
}
