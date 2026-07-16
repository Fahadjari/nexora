import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

/**
 * The root layout. Wraps every page in the app.
 *
 * Note there is no `'use client'` here — this IS a server component. It renders
 * once on the server, ships pure HTML, and costs the browser nothing. Only the
 * `<Providers>` island inside it is interactive.
 *
 * The RN analogy: this is your top-level `<App>`, except most of it never
 * becomes JavaScript at all.
 */
export const metadata: Metadata = {
  title: {
    default: 'Nexora',
    // Every page sets its own title; this frames it. Renders as "Leads · Nexora".
    template: '%s · Nexora',
  },
  description: 'The AI business operating system for growing companies.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is required — and only here.
    //
    // next-themes has to set `class="dark"` on <html> before the first paint,
    // otherwise the page flashes white then snaps to dark. It does that with an
    // inline script, which means the HTML the browser has differs from what the
    // server sent — and React would normally scream about that mismatch. This
    // tells it the difference is intentional. It is scoped to <html> alone, so
    // it does not mask real hydration bugs deeper in the tree.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-canvas font-sans text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
