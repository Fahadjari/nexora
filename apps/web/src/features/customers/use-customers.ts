'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch, ApiRequestError, type Paginated } from '@/lib/api-client';

export type CustomerStatus = 'ACTIVE' | 'INACTIVE' | 'CHURNED';

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  taxId: string | null;
  industry: string | null;
  status: CustomerStatus;
  creditLimit: string | null;
  paymentTermDays: number;
  /** Churn risk, 0–100, written by the Customer Success agent. Null until scored. */
  aiRiskScore: number | null;
  aiRiskReason: string | null;
  createdAt: string;
  owner: { id: string; firstName: string; lastName: string } | null;
  _count?: { deals: number; contacts: number };
}

export interface CustomerFilters {
  search?: string;
  status?: CustomerStatus;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
}

export const customerKeys = {
  all: ['customers'] as const,
  list: (filters: CustomerFilters) => ['customers', filters] as const,
};

export function useCustomers(filters: CustomerFilters) {
  return useQuery({
    queryKey: customerKeys.list(filters),
    queryFn: () => {
      const params = new URLSearchParams();

      if (filters.search) params.set('search', filters.search);
      if (filters.status) params.set('status', filters.status);
      if (filters.sortBy) params.set('sortBy', filters.sortBy);
      if (filters.sortOrder) params.set('sortOrder', filters.sortOrder);
      params.set('page', String(filters.page ?? 1));

      return apiFetch<Paginated<Customer>>(`/crm/customers?${params.toString()}`);
    },
    placeholderData: (previous) => previous,
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      name: string;
      email?: string;
      phone?: string;
      taxId?: string;
      industry?: string;
    }) => apiFetch<Customer>('/crm/customers', { method: 'POST', body: input }),

    onSuccess: (customer) => {
      void queryClient.invalidateQueries({ queryKey: customerKeys.all });
      toast.success(`${customer.name} added`);
    },

    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : 'Could not create the customer.',
      );
    },
  });
}
