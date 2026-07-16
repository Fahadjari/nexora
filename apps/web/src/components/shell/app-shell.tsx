'use client';

import {
  BarChart3,
  Boxes,
  LayoutDashboard,
  LogOut,
  Moon,
  Receipt,
  Sun,
  Target,
  Users,
  Sparkles,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '@/components/brand/logo';
import { Button, cn } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Hidden when the user lacks this permission. */
  permission?: string;
  /** Not built yet — shown, but visibly inert rather than 404ing. */
  comingSoon?: boolean;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: '/leads', label: 'Leads', icon: <Sparkles className="h-4 w-4" />, permission: 'crm.lead:read' },
  { href: '/pipeline', label: 'Pipeline', icon: <Target className="h-4 w-4" />, permission: 'crm.deal:read' },
  { href: '/customers', label: 'Customers', icon: <Users className="h-4 w-4" />, permission: 'crm.customer:read' },
  { href: '/sales', label: 'Sales', icon: <Receipt className="h-4 w-4" />, comingSoon: true },
  { href: '/inventory', label: 'Inventory', icon: <Boxes className="h-4 w-4" />, comingSoon: true },
  { href: '/reports', label: 'Reports', icon: <BarChart3 className="h-4 w-4" />, comingSoon: true },
];

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The theme is unknowable on the server — it lives in the browser. Rendering
  // a sun on the server and a moon on the client is a hydration mismatch, so we
  // render nothing until mounted. This is the standard next-themes dance and the
  // single most common Next.js bug people hit with dark mode.
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="h-8 w-8" />;

  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="h-8 w-8 p-0"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, tenant, clear, can } = useAuthStore();

  function handleSignOut() {
    clear();
    router.replace('/login');
  }

  const initials = user ? `${user.firstName[0]}${user.lastName[0]}` : '';

  return (
    <div className="flex min-h-screen">
      {/* --- Sidebar --- */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center px-5">
          <Logo gradient />
        </div>

        {/* The workspace name, made prominent on purpose.
            In a multi-tenant app the user's single most dangerous mistake is
            acting in the wrong company. Ambient, always-visible context is the
            cheapest way to prevent it. */}
        {tenant && (
          <div className="mx-3 mb-3 rounded-lg bg-muted px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
              Workspace
            </p>
            <p className="truncate text-[13px] font-medium">{tenant.name}</p>
          </div>
        )}

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((item) => {
            // Hide what the user cannot use. This is UX, not security — the API
            // rejects the call regardless. See auth-store's `can()`.
            if (item.permission && !can(item.permission)) return null;

            const active = pathname === item.href;

            if (item.comingSoon) {
              return (
                <div
                  key={item.href}
                  className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-subtle/50"
                  title="Not built yet"
                >
                  {item.icon}
                  {item.label}
                  <span className="ml-auto text-[10px] uppercase tracking-wide">Soon</span>
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                  active
                    ? 'bg-accent-subtle font-medium text-accent'
                    : 'text-subtle hover:bg-muted hover:text-foreground',
                )}
              >
                {item.icon}
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* --- User --- */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="truncate text-[11px] text-subtle">{user?.email}</p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            icon={<LogOut className="h-4 w-4" />}
            className="mt-1 w-full justify-start"
          >
            Sign out
          </Button>
        </div>
      </aside>

      {/* --- Main --- */}
      <div className="flex flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-canvas/80 px-5 backdrop-blur">
          <div className="lg:hidden">
            <Logo gradient markOnly />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 px-5 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
