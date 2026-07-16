'use client';

import { clsx, type ClassValue } from 'clsx';
import { Loader2 } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, with later Tailwind classes winning.
 *
 * Plain string concatenation does NOT work with Tailwind: `"px-2 px-4"` leaves
 * both classes in the DOM, and which one applies comes down to CSS source order
 * rather than your intent. `twMerge` understands that `px-4` supersedes `px-2`
 * and drops the loser — which is what makes a `className` prop actually
 * overridable.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:opacity-90 shadow-sm',
  secondary: 'bg-surface border border-border text-foreground hover:bg-muted',
  ghost: 'text-subtle hover:bg-muted hover:text-foreground',
  danger: 'bg-danger text-white hover:opacity-90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, children, className, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Disable while loading, or an impatient double-click submits the form
      // twice — which on a "create invoice" button means two invoices.
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium',
        'transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, className, id, ...props },
  ref,
) {
  const inputId = id ?? props.name;

  return (
    <div className="space-y-1.5">
      {label && (
        // A real <label> with htmlFor, not a styled <div>. It makes the label
        // clickable, and it is the only thing a screen reader will announce.
        <label htmlFor={inputId} className="block text-[13px] font-medium text-foreground">
          {label}
        </label>
      )}

      <input
        ref={ref}
        id={inputId}
        // Tells assistive tech the field is invalid, and links it to the message
        // below — a red border alone communicates nothing to a screen reader.
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        className={cn(
          'h-9 w-full rounded-lg border bg-surface px-3 text-sm',
          'placeholder:text-subtle/60',
          'transition-colors duration-150',
          error ? 'border-danger' : 'border-border hover:border-subtle/40',
          className,
        )}
        {...props}
      />

      {error ? (
        <p id={`${inputId}-error`} className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-[13px] text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * Spreads the standard div attributes rather than accepting only `className`.
 *
 * A component that swallows `role`, `aria-*` and event handlers cannot be made
 * accessible by its caller — the dialog below needs `role="dialog"` and
 * `aria-modal` on this exact element. A primitive should never be the reason an
 * accessibility attribute is impossible to attach.
 */
export function Card({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-border bg-surface shadow-card', className)}
      {...props}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/**
 * A loading placeholder shaped like the content it replaces.
 *
 * Spinners tell the user "something is happening"; skeletons tell them "an
 * article is coming, and it is about this big". The second is calmer, and it
 * stops the layout jumping when the data lands.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-muted', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-black/[0.04] to-transparent dark:via-white/[0.06]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

/**
 * What a list shows when it has nothing to show.
 *
 * An empty table with headers and no rows looks broken. An empty state that
 * names the thing and offers the action turns a dead end into an onboarding
 * step — which for a new SMB signing up is most of their first session.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-subtle">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-[13px] text-subtle">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
