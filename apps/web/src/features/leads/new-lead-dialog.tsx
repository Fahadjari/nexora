'use client';

import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { useCreateLead } from './use-leads';

interface NewLeadDialogProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  companyName: '',
  jobTitle: '',
  estimatedValue: '',
};

export function NewLeadDialog({ open, onClose }: NewLeadDialogProps) {
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const createLead = useCreateLead();

  // Escape closes it. A modal you can only leave by aiming at a small × is a
  // modal that traps keyboard users.
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
      await createLead.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        // Send undefined, not '', for the optional fields. An empty string is a
        // *value* — it would fail the API's email validator and store a blank
        // where the schema means "no email on record".
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        companyName: form.companyName.trim() || undefined,
        jobTitle: form.jobTitle.trim() || undefined,
        estimatedValue: form.estimatedValue ? Number(form.estimatedValue) : undefined,
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
      {/* The scrim. Clicking it closes the dialog — expected behaviour, and it
          gives the modal a clear boundary. */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />

      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-lead-title"
        className="relative w-full max-w-md animate-fade-up p-6"
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 id="new-lead-title" className="text-base font-semibold">
              New lead
            </h2>
            <p className="mt-0.5 text-[13px] text-subtle">
              Nexora will score it automatically once saved.
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
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="First name"
              name="firstName"
              required
              autoFocus
              value={form.firstName}
              onChange={(event) => update('firstName', event.target.value)}
              error={fieldErrors.firstName}
            />
            <Input
              label="Last name"
              name="lastName"
              required
              value={form.lastName}
              onChange={(event) => update('lastName', event.target.value)}
              error={fieldErrors.lastName}
            />
          </div>

          <Input
            label="Company"
            name="companyName"
            value={form.companyName}
            onChange={(event) => update('companyName', event.target.value)}
            error={fieldErrors.companyName}
            placeholder="Bright Steel Traders"
          />

          <Input
            label="Email"
            name="email"
            type="email"
            value={form.email}
            onChange={(event) => update('email', event.target.value)}
            error={fieldErrors.email}
            placeholder="name@company.com"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Job title"
              name="jobTitle"
              value={form.jobTitle}
              onChange={(event) => update('jobTitle', event.target.value)}
              error={fieldErrors.jobTitle}
            />
            <Input
              label="Est. value"
              name="estimatedValue"
              type="number"
              min={0}
              value={form.estimatedValue}
              onChange={(event) => update('estimatedValue', event.target.value)}
              error={fieldErrors.estimatedValue}
              placeholder="250000"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createLead.isPending}>
              Create lead
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
