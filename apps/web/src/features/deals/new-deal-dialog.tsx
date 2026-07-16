'use client';

import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input } from '@/components/ui';
import { useCustomers } from '@/features/customers/use-customers';
import { ApiRequestError } from '@/lib/api-client';
import { useCreateDeal } from './use-deals';

interface NewDealDialogProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY = {
  title: '',
  value: '',
  customerId: '',
  expectedCloseDate: '',
};

export function NewDealDialog({ open, onClose }: NewDealDialogProps) {
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const createDeal = useCreateDeal();

  // Only fetched while the dialog is open — there is no reason to pull the
  // customer list on every board render for a picker nobody has opened.
  const { data: customers } = useCustomers({ sortBy: 'name', sortOrder: 'asc' });

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function update(field: keyof typeof EMPTY, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});

    try {
      await createDeal.mutateAsync({
        title: form.title.trim(),
        value: Number(form.value),
        customerId: form.customerId || undefined,
        expectedCloseDate: form.expectedCloseDate || undefined,
      });

      setForm(EMPTY);
      onClose();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setFieldErrors(error.fieldErrors);
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />

      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-deal-title"
        className="relative w-full max-w-md animate-fade-up p-6"
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 id="new-deal-title" className="text-base font-semibold">
              New deal
            </h2>
            <p className="mt-0.5 text-[13px] text-subtle">
              Opens in the first stage. Nexora will forecast it once saved.
            </p>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Input
            label="What is the deal?"
            name="title"
            required
            autoFocus
            value={form.title}
            onChange={(event) => update('title', event.target.value)}
            error={fieldErrors.title}
            placeholder="400 tonnes TMT bars — Q3"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Value"
              name="value"
              type="number"
              min={0}
              required
              value={form.value}
              onChange={(event) => update('value', event.target.value)}
              error={fieldErrors.value}
              placeholder="850000"
            />

            <Input
              label="Expected close"
              name="expectedCloseDate"
              type="date"
              value={form.expectedCloseDate}
              onChange={(event) => update('expectedCloseDate', event.target.value)}
              error={fieldErrors.expectedCloseDate}
              hint="Drives the forecast."
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="customerId" className="block text-[13px] font-medium">
              Customer
            </label>

            <select
              id="customerId"
              name="customerId"
              value={form.customerId}
              onChange={(event) => update('customerId', event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm transition-colors hover:border-subtle/40"
            >
              {/* Optional on purpose. Reps open deals before the paperwork
                  exists, and forcing a customer first means the deal gets
                  tracked in a spreadsheet instead — which is the failure mode
                  this product is trying to end. */}
              <option value="">No customer yet</option>

              {customers?.data.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>

            <p className="text-[13px] text-subtle">You can attach one later.</p>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createDeal.isPending}>
              Open deal
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
