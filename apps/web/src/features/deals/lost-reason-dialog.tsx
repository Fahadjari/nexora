'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card } from '@/components/ui';

interface LostReasonDialogProps {
  open: boolean;
  /** The deal being lost, for a title that names it rather than saying "this deal". */
  dealTitle?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  pending?: boolean;
}

/**
 * Asks why a deal was lost, before letting it be lost.
 *
 * The API refuses a loss with no reason, so this dialog is not merely a nicety —
 * without it, dragging a card to "Lost" would just bounce with a validation
 * error and the user would have no way to comply.
 *
 * It is worth being clear about why the API demands it. "Why did we lose?"
 * answered in the moment is worth something; reconstructed from memory a month
 * later it is worth nothing. It is also the only training signal the
 * loss-prediction model will ever get — every unanswered loss is a permanently
 * missing row.
 */
export function LostReasonDialog({
  open,
  dealTitle,
  onCancel,
  onConfirm,
  pending,
}: LostReasonDialogProps) {
  const [reason, setReason] = useState('');

  // Reset between deals, or the reason typed for the last lost deal is sitting
  // there pre-filled for the next one — and someone will hit save on it.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = reason.trim();
    if (!trimmed) return;

    onConfirm(trimmed);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Cancelling here must put the card back where it came from — the caller
          is responsible for that, and does. */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onCancel}
        aria-hidden
      />

      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="lost-reason-title"
        className="relative w-full max-w-md animate-fade-up p-6"
      >
        <h2 id="lost-reason-title" className="text-base font-semibold">
          Why was this deal lost?
        </h2>

        <p className="mt-0.5 text-[13px] text-subtle">
          {dealTitle ? (
            <>
              Marking <span className="font-medium text-foreground">{dealTitle}</span> as lost.
            </>
          ) : (
            'Marking this deal as lost.'
          )}{' '}
          Nexora learns from this — vague answers teach it nothing.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="lostReason" className="block text-[13px] font-medium">
              Reason
            </label>

            <textarea
              id="lostReason"
              name="lostReason"
              required
              autoFocus
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Lost on price — a competitor undercut us by about 12%."
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm transition-colors placeholder:text-subtle/60 hover:border-subtle/40"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>

            {/* Disabled until there is actually a reason. The server would reject
                an empty one anyway; blocking it here saves a pointless round trip
                and a red toast. */}
            <Button type="submit" variant="danger" loading={pending} disabled={!reason.trim()}>
              Mark as lost
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
