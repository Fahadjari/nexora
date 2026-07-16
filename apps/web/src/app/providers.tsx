'use client';

/**
 * `'use client'` — the most important line in the file.
 *
 * Coming from React Native, every component you have ever written was a client
 * component: it ran on the device, had state, had effects. In Next.js the
 * DEFAULT is the opposite — components render on the *server*, produce HTML, and
 * ship no JavaScript. That is why pages load fast.
 *
 * But a server component cannot have `useState`, `useEffect`, or an onClick
 * handler, because none of those mean anything on a server. Anything
 * interactive must opt back in with `'use client'`.
 *
 * Providers are the canonical case: they hold state (the query cache, the theme)
 * and therefore must run in the browser.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

export function Providers({ children }: { children: ReactNode }) {
  // `useState` and not a module-level `new QueryClient()`.
  //
  // On a server, module scope is shared across *every* request from *every*
  // user. A cache up there would let one company's leads be served to another
  // company — the exact leak the whole backend is built to prevent, reintroduced
  // in the frontend. Creating it inside the component gives each browser session
  // its own instance.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is considered fresh for 30s. Prevents a refetch storm when a
            // user tabs away and back, which is otherwise constant.
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Never retry a 401/403/404 — the answer will not change, and
              // retrying a 401 three times just delays the login redirect.
              const status = (error as { status?: number })?.status;
              if (status && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        // Without this, every theme change animates every colour on the page
        // at once, which looks like a glitch rather than a transition.
        disableTransitionOnChange
      >
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast: 'bg-surface border-border text-foreground shadow-popover',
            },
          }}
        />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
