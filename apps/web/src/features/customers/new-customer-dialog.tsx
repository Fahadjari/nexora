'use client';

import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { useCreateCustomer } from './use-customers';

interface NewCustomerDialogProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY = {
  name: '',
  email: '',
  phone: '',
  taxId: '',
  industry: '',
};

export function NewCustomerDialog({ open, onClose }: NewCustomerDialogProps) {
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const createCustomer = useCreateCustomer();

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
      await createCustomer.mutateAsync({
        name: form.name.trim(),
        // Empty string is a value, not an absence — it would fail the API's
        // email validator and store a blank where the schema means "not on
        // record".
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        taxId: form.taxId.trim() || undefined,
        industry: form.industry.trim() || undefined,
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
        aria-labelledby="new-customer-title"
        className="relative w-full max-w-md animate-fade-up p-6"
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 id="new-customer-title" className="text-base font-semibold">
              New customer
            </h2>
            <p className="mt-0.5 text-[13px] text-subtle">
              An account you sell to. Deals and invoices hang off this.
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
            label="Company name"
            name="name"
            required
            autoFocus
            value={form.name}
            onChange={(event) => update('name', event.target.value)}
            error={fieldErrors.name}
            placeholder="Bright Steel Traders"
          />

          <Input
            label="Email"
            name="email"
            type="email"
            value={form.email}
            onChange={(event) => update('email', event.target.value)}
            error={fieldErrors.email}
            placeholder="accounts@brightsteel.in"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Phone"
              name="phone"
              value={form.phone}
              onChange={(event) => update('phone', event.target.value)}
              error={fieldErrors.phone}
            />
            <Input
              label="Industry"
              name="industry"
              value={form.industry}
              onChange={(event) => update('industry', event.target.value)}
              error={fieldErrors.industry}
              placeholder="Manufacturing"
            />
          </div>

          <Input
            label="GSTIN"
            name="taxId"
            value={form.taxId}
            onChange={(event) => update('taxId', event.target.value)}
            error={fieldErrors.taxId}
            hint="Needed on their invoices. You can add it later."
            placeholder="27AAPFU0939F1ZV"
          />

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createCustomer.isPending}>
              Create customer
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
