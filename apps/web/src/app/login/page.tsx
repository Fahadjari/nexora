'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/brand/logo';
import { Button, Card, Input } from '@/components/ui';
import { apiFetch, ApiRequestError } from '@/lib/api-client';
import { useAuthStore, type AuthTenant, type AuthUser } from '@/lib/auth-store';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  tenant: AuthTenant;
  permissions: string[];
}

export default function LoginPage() {
  const router = useRouter();
  const { setSession, accessToken, hasHydrated } = useAuthStore();

  const [email, setEmail] = useState('priya@acmetrading.in');
  const [password, setPassword] = useState('nexora-demo-2026');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Already signed in? Skip the form.
  //
  // Gated on `hasHydrated` — before rehydration the token is always null, so
  // acting on it early would mean a logged-in user briefly sees the login page
  // on every refresh.
  useEffect(() => {
    if (hasHydrated && accessToken) {
      router.replace('/dashboard');
    }
  }, [hasHydrated, accessToken, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFieldErrors({});

    try {
      const session = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });

      setSession(session);

      toast.success(`Welcome back, ${session.user.firstName}`);
      router.replace('/dashboard');
    } catch (error) {
      if (error instanceof ApiRequestError) {
        // Field-level messages go under the field. Everything else is a toast —
        // "Incorrect email or password" belongs at the top of the form, not
        // attached to one input, because we deliberately do not say which.
        setFieldErrors(error.fieldErrors);

        if (Object.keys(error.fieldErrors).length === 0) {
          toast.error(error.message);
        }
      } else {
        toast.error('Could not reach the server. Is the API running?');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      {/* A whisper of brand colour behind the card. Enough to feel designed,
          not enough to compete with the form. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(60rem_40rem_at_50%_-10%,hsl(var(--accent)/0.07),transparent)]"
      />

      <div className="relative w-full max-w-[380px] animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo gradient className="mb-6" />
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Nexora</h1>
          <p className="mt-1.5 text-[13px] text-subtle">
            Your business, and the AI that runs it with you.
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Input
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              // The first field should be focused on arrival — one less click,
              // every single time.
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={fieldErrors.email}
              placeholder="you@company.com"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
              placeholder="••••••••••••"
            />

            <Button type="submit" loading={submitting} className="w-full">
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        {/* Development affordance. It would be removed before this ever met a
            real customer — but while building, retyping a password on every
            reload is a tax on the person doing the work. */}
        <div className="mt-5 rounded-lg border border-dashed border-border px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
            Demo accounts
          </p>
          <div className="mt-2 space-y-1.5 text-[12px] text-subtle">
            <button
              type="button"
              onClick={() => {
                setEmail('priya@acmetrading.in');
                setPassword('nexora-demo-2026');
              }}
              className="block w-full text-left transition-colors hover:text-foreground"
            >
              <span className="font-mono">priya@acmetrading.in</span> — Owner, Acme Trading
            </button>
            <button
              type="button"
              onClick={() => {
                setEmail('anita@brightsteel.in');
                setPassword('nexora-demo-2026');
              }}
              className="block w-full text-left transition-colors hover:text-foreground"
            >
              <span className="font-mono">anita@brightsteel.in</span> — Employee, Bright Steel
            </button>
          </div>
          <p className="mt-2 text-[11px] text-subtle/70">
            Sign in as each to see tenant isolation and role permissions differ.
          </p>
        </div>
      </div>
    </main>
  );
}
