'use client';

import { Plus, Search, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, Input, Skeleton, cn } from '@/components/ui';
import { useAuthStore } from '@/lib/auth-store';
import { formatMoney, useLeads, type Lead, type LeadStatus } from '@/features/leads/use-leads';
import { NewLeadDialog } from '@/features/leads/new-lead-dialog';

const STATUS_STYLES: Record<LeadStatus, string> = {
  NEW: 'bg-muted text-subtle',
  CONTACTED: 'bg-accent-subtle text-accent',
  QUALIFIED: 'bg-success/10 text-success',
  UNQUALIFIED: 'bg-muted text-subtle line-through',
  CONVERTED: 'bg-success/15 text-success',
};

/**
 * The AI score, rendered so it can be read at a glance.
 *
 * Colour is doing real work here: a rep scanning fifty rows needs to find the
 * hot leads without reading a single number. But colour is never the ONLY
 * signal — the number is always there too, because roughly 1 in 12 men has some
 * form of colour blindness, and an interface that encodes meaning purely in hue
 * is unusable for them.
 *
 * A null score is not a zero. "Not yet scored" and "scored, and it is bad" are
 * completely different facts, and collapsing them into 0 would slander a lead
 * the model has not even looked at.
 */
function AiScore({ score, reason }: { score: number | null; reason: string | null }) {
  if (score === null) {
    return (
      <span className="text-[13px] text-subtle/50" title="Not scored yet">
        —
      </span>
    );
  }

  const tone =
    score >= 70
      ? 'bg-success/10 text-success'
      : score >= 40
        ? 'bg-warning/10 text-warning'
        : 'bg-muted text-subtle';

  return (
    <span
      // The model's justification, on hover. The score is a claim; the reason is
      // the evidence. Showing a number with no rationale is how people learn to
      // distrust the AI.
      title={reason ?? undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium tabular',
        tone,
      )}
    >
      <Sparkles className="h-3 w-3" />
      {score}
    </span>
  );
}

function LeadRow({ lead }: { lead: Lead }) {
  return (
    <tr className="border-b border-border last:border-0 transition-colors hover:bg-muted/50">
      <td className="px-4 py-3">
        <div className="font-medium">
          {lead.firstName} {lead.lastName}
        </div>
        {lead.jobTitle && <div className="text-[12px] text-subtle">{lead.jobTitle}</div>}
      </td>

      <td className="px-4 py-3 text-[13px]">{lead.companyName ?? <span className="text-subtle/50">—</span>}</td>

      <td className="px-4 py-3 text-[13px] text-subtle">
        {lead.email ?? <span className="text-subtle/50">—</span>}
      </td>

      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex rounded-md px-1.5 py-0.5 text-[12px] font-medium',
            STATUS_STYLES[lead.status],
          )}
        >
          {lead.status.toLowerCase()}
        </span>
      </td>

      {/* Money is right-aligned and tabular so the digits line up in a column —
          otherwise scanning for the big numbers means reading every one. */}
      <td className="px-4 py-3 text-right text-[13px] tabular">
        {formatMoney(lead.estimatedValue)}
      </td>

      <td className="px-4 py-3 text-right">
        <AiScore score={lead.aiScore} reason={lead.aiScoreReason} />
      </td>
    </tr>
  );
}

export default function LeadsPage() {
  const can = useAuthStore((state) => state.can);

  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, isError, error } = useLeads({
    search: search || undefined,
    sortBy: 'aiScore',
    sortOrder: 'desc',
  });

  const canCreate = can('crm.lead:create');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-0.5 text-[13px] text-subtle">
            Sorted by AI score — your hottest prospects first.
          </p>
        </div>

        {/* Hidden for roles without the permission. The API would reject the
            call anyway; this just avoids offering an action that cannot work. */}
        {canCreate && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
            New lead
          </Button>
        )}
      </div>

      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input
          placeholder="Search name, company, email…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-9"
          aria-label="Search leads"
        />
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          // A skeleton shaped like the table that is coming, rather than a
          // spinner. The layout does not jump when the data lands.
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            title="Could not load leads"
            description={
              error instanceof Error ? error.message : 'Something went wrong. Try again.'
            }
          />
        ) : data && data.data.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title={search ? 'No leads match that search' : 'No leads yet'}
            description={
              search
                ? 'Try a different name, company or email.'
                : 'Add your first lead and Nexora will score it for you automatically.'
            }
            action={
              canCreate && !search ? (
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
                  New lead
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-medium uppercase tracking-wide text-subtle">
                  <th scope="col" className="px-4 py-2.5">Name</th>
                  <th scope="col" className="px-4 py-2.5">Company</th>
                  <th scope="col" className="px-4 py-2.5">Email</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Value</th>
                  <th scope="col" className="px-4 py-2.5 text-right">AI score</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data && data.data.length > 0 && (
        <p className="text-[13px] text-subtle">
          {data.meta.total} {data.meta.total === 1 ? 'lead' : 'leads'}
        </p>
      )}

      <NewLeadDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
