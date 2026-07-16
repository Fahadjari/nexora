'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch, ApiRequestError, type Paginated } from '@/lib/api-client';

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'UNQUALIFIED' | 'CONVERTED';

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  jobTitle: string | null;
  status: LeadStatus;
  source: string;
  /** Decimal arrives as a STRING, not a number — deliberately. See formatMoney. */
  estimatedValue: string | null;
  aiScore: number | null;
  aiScoreReason: string | null;
  aiScoredAt: string | null;
  createdAt: string;
  owner: { id: string; firstName: string; lastName: string } | null;
}

export interface LeadFilters {
  search?: string;
  status?: LeadStatus;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
}

/**
 * Query keys.
 *
 * Every cached query is identified by an array. `['leads', filters]` means
 * changing a filter is a *different* query — so TanStack fetches it, caches it
 * separately, and returns instantly if you flip back. Invalidating `['leads']`
 * clears every variation at once, which is what you want after a create.
 *
 * Keeping them in one place prevents the classic bug where a component
 * invalidates `['lead']` while the query registered under `['leads']`, and the
 * screen silently never refreshes.
 */
export const leadKeys = {
  all: ['leads'] as const,
  list: (filters: LeadFilters) => ['leads', filters] as const,
};

export function useLeads(filters: LeadFilters) {
  return useQuery({
    queryKey: leadKeys.list(filters),
    queryFn: () => {
      const params = new URLSearchParams();

      if (filters.search) params.set('search', filters.search);
      if (filters.status) params.set('status', filters.status);
      if (filters.sortBy) params.set('sortBy', filters.sortBy);
      if (filters.sortOrder) params.set('sortOrder', filters.sortOrder);
      params.set('page', String(filters.page ?? 1));

      return apiFetch<Paginated<Lead>>(`/crm/leads?${params.toString()}`);
    },
    // Keep the previous page's rows on screen while the next loads, rather than
    // flashing an empty table. Makes pagination feel instant.
    placeholderData: (previous) => previous,
  });
}

export function useCreateLead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      firstName: string;
      lastName: string;
      email?: string;
      phone?: string;
      companyName?: string;
      jobTitle?: string;
      estimatedValue?: number;
    }) => apiFetch<Lead>('/crm/leads', { method: 'POST', body: input }),

    onSuccess: (lead) => {
      // Refetch rather than surgically inserting the new row into the cache:
      // the server decides sort order, pagination and defaults, and guessing at
      // those is how a list ends up quietly disagreeing with the database.
      void queryClient.invalidateQueries({ queryKey: leadKeys.all });

      toast.success(`${lead.firstName} ${lead.lastName} added`, {
        description: 'AI is scoring this lead in the background.',
      });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not create the lead.');
    },
  });
}

/**
 * Formats a money value that arrived as a string.
 *
 * The API sends Decimal as a string on purpose. JavaScript numbers are IEEE-754
 * doubles and genuinely cannot hold every decimal value — `0.1 + 0.2` is famously
 * `0.30000000000000004`. That is a curiosity in a game and a lawsuit in an
 * invoice. So money crosses the wire as text and is only turned into a number at
 * the very last moment, for display.
 */
export function formatMoney(value: string | null, currency = 'INR'): string {
  if (!value) return '—';

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value));
}
