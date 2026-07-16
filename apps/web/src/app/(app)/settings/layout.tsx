'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';

const TABS = [
  { href: '/settings/billing', label: 'Plan & Billing' },
  // The tab hides without member:read, but that is rendering courtesy — the
  // API enforces the permission regardless of what the sidebar shows.
  { href: '/settings/team', label: 'Team', permission: 'member:read' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const can = useAuthStore((state) => state.can);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[13px] text-subtle">Your workspace, plan and people.</p>
      </div>

      <nav className="flex gap-1 border-b border-border" aria-label="Settings sections">
        {TABS.map((tab) => {
          if (tab.permission && !can(tab.permission)) return null;

          const active = pathname === tab.href;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                active
                  ? 'border-accent text-foreground'
                  : 'border-transparent text-subtle hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
