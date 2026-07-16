'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/brand/logo';
import { Button, Card, Input } from '@/components/ui';
import { apiFetch, ApiRequestError } from '@/lib/api-client';
import { useAuthStore, type AuthTenant, type AuthUser } from '@/lib/auth-store';

interface RegisterResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  tenant: AuthTenant;
  permissions: string[];
}

/**
 * Where a business becomes a customer.
 *
 * One form, six fields, no card. The 14-day trial is the whole pitch of this
 * page, and every field beyond the minimum is a percentage of signups lost —
 * so there is no phone number, no company size dropdown, no "how did you hear
 * about us". Those questions can be asked later, of someone who is already in.
 */
export default function RegisterPage() {
  const router = useRouter();
  const { setSession, accessToken, hasHydrated } = useAuthStore();

  const [form, setForm] = useState({
    companyName: '',
    firstName: '',
    lastName: '',
    email: '',
    password: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Already signed in → straight to work. Same hydration gate as /login.
  useEffect(() => {
    if (hasHydrated && accessToken) {
      router.replace('/dashboard');
    }
  }, [hasHydrated, accessToken, router]);

  function update(field: keyof typeof form, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFieldErrors({});

    try {
      const session = await apiFetch<RegisterResponse>('/auth/register', {
        method: 'POST',
        body: {
          companyName: form.companyName.trim(),
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          password: form.password,
        },
      });

      // Registration returns a full session — the new owner lands inside their
      // workspace, not on a "now go log in" page. Every extra step between
      // "decided to try it" and "using it" is where trials die.
      setSession(session);

      toast.success(`Welcome to Nexora, ${session.user.firstName}`, {
        description: 'Your 14-day trial has started — every feature is on.',
      });

      router.replace('/dashboard');
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setFieldErrors(error.fieldErrors);

        if (Object.keys(error.fieldErrors).length === 0) {
          toast.error(error.message);
        }
      } else {
        toast.error('Could not reach the server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(60rem_40rem_at_50%_-10%,hsl(var(--accent)/0.07),transparent)]"
      />

      <div className="relative w-full max-w-[420px] animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo gradient className="mb-6" />
          <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1.5 text-[13px] text-subtle">
            14 days of everything, free. No card, no sales call.
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Input
              label="Company name"
              name="companyName"
              autoFocus
              required
              value={form.companyName}
              onChange={(event) => update('companyName', event.target.value)}
              error={fieldErrors.companyName}
              placeholder="Acme Trading Co."
              hint="This becomes your workspace. You can rename it later."
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="First name"
                name="firstName"
                autoComplete="given-name"
                required
                value={form.firstName}
                onChange={(event) => update('firstName', event.target.value)}
                error={fieldErrors.firstName}
              />
              <Input
                label="Last name"
                name="lastName"
                autoComplete="family-name"
                required
                value={form.lastName}
                onChange={(event) => update('lastName', event.target.value)}
                error={fieldErrors.lastName}
              />
            </div>

            <Input
              label="Work email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(event) => update('email', event.target.value)}
              error={fieldErrors.email}
              placeholder="you@company.com"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(event) => update('password', event.target.value)}
              error={fieldErrors.password}
              placeholder="At least 8 characters"
            />

            <Button type="submit" loading={submitting} className="w-full">
              {submitting ? 'Creating your workspace…' : 'Start free trial'}
            </Button>
          </form>
        </Card>

        <p className="mt-5 text-center text-[13px] text-subtle">
          Already using Nexora?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
