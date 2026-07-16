'use client';

import { AlertTriangle, Building2, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, Input, Skeleton, cn } from '@/components/ui';
import { formatMoney } from '@/features/leads/use-leads';
import { NewCustomerDialog } from '@/features/customers/new-customer-dialog';
import {
  useCustomers,
  type Customer,
  type CustomerStatus,
} from '@/features/customers/use-customers';
import { useAuthStore } from '@/lib/auth-store';

const STATUS_STYLES: Record<CustomerStatus, string> = {
  ACTIVE: 'bg-success/10 text-success',
  INACTIVE: 'bg-muted text-subtle',
  CHURNED: 'bg-danger/10 text-danger',
};

/**
 * Churn risk.
 *
 * The inverse of the lead score, and the colours have to be inverted with it:
 * on a lead, a high number is good news; here, a high number means you are about
 * to lose the account. Reusing the lead's green-is-high palette would paint the
 * customers you are about to lose in the colour of success — the kind of quiet
 * mistake that trains people to ignore the indicator entirely.
 *
 * Null is not zero. "Not yet assessed" and "assessed, and they are safe" are
 * different facts.
 */
function RiskScore({ score, reason }: { score: number | null; reason: string | null }) {
  if (score === null) {
    return (
      <span className="text-[13px] text-subtle/50" title="Not assessed yet">
        —
      </span>
    );
  }

  const atRisk = score >= 70;

  const tone = atRisk
    ? 'bg-danger/10 text-danger'
    : score >= 40
      ? 'bg-warning/10 text-warning'
      : 'bg-muted text-subtle';

  return (
    <span
      title={reason ?? undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium tabular',
        tone,
      )}
    >
      {/* Colour alone is never the signal — roughly 1 in 12 men cannot rely on
          it. The icon carries the same warning independently. */}
      {atRisk && <AlertTriangle className="h-3 w-3" />}
      {score}
    </span>
  );
}

function CustomerRow({ customer }: { customer: Customer }) {
  return (
    <tr className="border-b border-border transition-colors last:border-0 hover:bg-muted/50">
      <td className="px-4 py-3">
        <div className="font-medium">{customer.name}</div>
        {customer.industry && (
          <div className="text-[12px] text-subtle">{customer.industry}</div>
        )}
      </td>

      <td className="px-4 py-3 text-[13px] text-subtle">
        {customer.email ?? <span className="text-subtle/50">—</span>}
      </td>

      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex rounded-md px-1.5 py-0.5 text-[12px] font-medium',
            STATUS_STYLES[customer.status],
          )}
        >
          {customer.status.toLowerCase()}
        </span>
      </td>

      <td className="px-4 py-3 text-right text-[13px] tabular">
        {customer._count?.deals ?? 0}
      </td>

      <td className="px-4 py-3 text-right text-[13px] tabular">
        {formatMoney(customer.creditLimit)}
      </td>

      <td className="px-4 py-3 text-right">
        <RiskScore score={customer.aiRiskScore} reason={customer.aiRiskReason} />
      </td>
    </tr>
  );
}

export default function CustomersPage() {
  const can = useAuthStore((state) => state.can);

  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  // Riskiest first. A customer list sorted alphabetically is a directory; sorted
  // by who is about to leave, it is a to-do list.
  const { data, isLoading, isError, error } = useCustomers({
    search: search || undefined,
    sortBy: 'aiRiskScore',
    sortOrder: 'desc',
  });

  const canCreate = can('crm.customer:create');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-0.5 text-[13px] text-subtle">
            Sorted by churn risk — the accounts that need attention first.
          </p>
        </div>

        {canCreate && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
            New customer
          </Button>
        )}
      </div>

      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input
          placeholder="Search name, email, GSTIN…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-9"
          aria-label="Search customers"
        />
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            title="Could not load customers"
            description={
              error instanceof Error ? error.message : 'Something went wrong. Try again.'
            }
          />
        ) : data && data.data.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" />}
            title={search ? 'No customers match that search' : 'No customers yet'}
            description={
              search
                ? 'Try a different name, email or GSTIN.'
                : 'Add an account directly, or convert a qualified lead and Nexora will create one for you.'
            }
            action={
              canCreate && !search ? (
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
                  New customer
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-medium uppercase tracking-wide text-subtle">
                  <th scope="col" className="px-4 py-2.5">Customer</th>
                  <th scope="col" className="px-4 py-2.5">Email</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Deals</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Credit limit</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Churn risk</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((customer) => (
                  <CustomerRow key={customer.id} customer={customer} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data && data.data.length > 0 && (
        <p className="text-[13px] text-subtle">
          {data.meta.total} {data.meta.total === 1 ? 'customer' : 'customers'}
        </p>
      )}

      <NewCustomerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
