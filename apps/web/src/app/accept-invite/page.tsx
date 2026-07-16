'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/brand/logo';
import { Button, Card, Input, Skeleton } from '@/components/ui';
import { useInvitePreview } from '@/features/team/use-team';
import { apiFetch, ApiRequestError } from '@/lib/api-client';
import { useAuthStore, type AuthTenant, type AuthUser } from '@/lib/auth-store';

interface AcceptResponse {
  accessToken?: string;
  refreshToken?: string;
  user?: AuthUser;
  tenant?: AuthTenant;
  permissions?: string[];
  /** The existing-account path: seat attached, but they sign in themselves. */
  requiresLogin?: boolean;
  email?: string;
}

/**
 * Where an invite link lands.
 *
 * The person arriving here is the least-invested user the product will ever
 * meet: they did not choose Nexora, their boss did. The page has one job —
 * get them from link to logged-in with the minimum possible friction, and
 * *show them where they are joining* before asking for anything.
 */
function AcceptInviteInner() {
  const router = useRouter();
  const setSession = useAuthStore((state) => state.setSession);

  const token = useSearchParams().get('token');
  const { data: invite, isLoading, isError, error } = useInvitePreview(token);

  const [form, setForm] = useState({ firstName: '', lastName: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /**
   * Takes the payload explicitly rather than reading component state, because
   * the existing-account path submits values the user never typed — and calling
   * setState-then-submit would read the *previous* state anyway (setState is
   * async). Explicit arguments make that whole class of bug unwritable.
   */
  async function submitAccept(payload: { firstName: string; lastName: string; password: string }) {
    setSubmitting(true);
    setFieldErrors({});

    try {
      const result = await apiFetch<AcceptResponse>(
        `/members/invitations/token/${token}/accept`,
        {
          method: 'POST',
          body: payload,
        },
      );

      if (result.requiresLogin) {
        // Their address already has a Nexora account. The seat is attached; the
        // API deliberately does not mint a session off a shareable link for an
        // account it hasn't authenticated.
        toast.success('Seat added to your account', {
          description: 'Sign in with your existing password to enter.',
        });
        router.replace('/login');
        return;
      }

      setSession({
        accessToken: result.accessToken!,
        refreshToken: result.refreshToken!,
        user: result.user,
        tenant: result.tenant,
        permissions: result.permissions,
      });

      toast.success(`Welcome aboard, ${result.user!.firstName}`);
      router.replace('/dashboard');
    } catch (submitError) {
      if (submitError instanceof ApiRequestError) {
        setFieldErrors(submitError.fieldErrors);

        // Never silent — same rule as the register page. If no returned field
        // error lands on an input this form renders, say it out loud.
        const visible = Object.keys(submitError.fieldErrors).some((field) => field in form);

        if (!visible) {
          toast.error(Object.values(submitError.fieldErrors)[0] ?? submitError.message);
        }
      } else {
        toast.error('Could not reach the server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    void submitAccept({
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      password: form.password,
    });
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

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="mx-auto h-6 w-56" />
              <Skeleton className="mx-auto h-4 w-72" />
            </div>
          ) : isError || !invite ? (
            <>
              <h1 className="text-xl font-semibold tracking-tight">
                This invitation isn&apos;t valid
              </h1>
              <p className="mt-1.5 max-w-sm text-[13px] text-subtle">
                {!token
                  ? 'The link is missing its token — it may have been copied incompletely.'
                  : error instanceof Error
                    ? error.message
                    : 'It may have expired or been revoked.'}{' '}
                Ask the person who invited you to send a fresh one.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight">
                Join {invite.companyName}
              </h1>
              <p className="mt-1.5 text-[13px] text-subtle">
                {invite.invitedBy} invited{' '}
                <span className="font-medium text-foreground">{invite.email}</span> as{' '}
                <span className="font-medium text-foreground">{invite.roleName}</span>.
              </p>
            </>
          )}
        </div>

        {invite && !invite.hasAccount && (
          <Card className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="First name"
                  name="firstName"
                  autoFocus
                  required
                  value={form.firstName}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, firstName: event.target.value }))
                  }
                  error={fieldErrors.firstName}
                />
                <Input
                  label="Last name"
                  name="lastName"
                  required
                  value={form.lastName}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, lastName: event.target.value }))
                  }
                  error={fieldErrors.lastName}
                />
              </div>

              <Input
                label="Choose a password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={form.password}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, password: event.target.value }))
                }
                error={fieldErrors.password}
                placeholder="At least 12 characters"
                hint={`Your sign-in will be ${invite.email}`}
              />

              <Button type="submit" loading={submitting} className="w-full">
                {submitting ? 'Joining…' : `Join ${invite.companyName}`}
              </Button>
            </form>
          </Card>
        )}

        {invite?.hasAccount && (
          <Card className="p-6 text-center">
            <p className="text-sm">
              You already have a Nexora account under{' '}
              <span className="font-medium">{invite.email}</span>.
            </p>
            <p className="mt-1 text-[13px] text-subtle">
              Accept the seat with one click — then sign in as usual.
            </p>

            {/* Existing accounts still POST the same accept endpoint; the API
                attaches the seat and answers `requiresLogin` — it ignores the
                name/password fields on this path (it will not overwrite an
                account off a shareable link). The placeholders exist purely to
                satisfy the DTO's validators without making the user retype
                anything. */}
            <Button
              className="mt-4 w-full"
              loading={submitting}
              onClick={() =>
                void submitAccept({
                  firstName: 'existing',
                  lastName: 'account',
                  password: 'placeholder-ignored',
                })
              }
            >
              Accept invitation
            </Button>
          </Card>
        )}

        <p className="mt-5 text-center text-[13px] text-subtle">
          New to Nexora?{' '}
          <Link href="/register" className="font-medium text-accent hover:underline">
            Start your own workspace
          </Link>
        </p>
      </div>
    </main>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary in the App Router — without
 * one, the whole route falls back to client-side rendering with a build
 * warning. The fallback matches the page's own loading state.
 */
export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
        </main>
      }
    >
      <AcceptInviteInner />
    </Suspense>
  );
}
