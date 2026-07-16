'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch, ApiRequestError } from '@/lib/api-client';

export interface PipelineStage {
  id: string;
  name: string;
  position: number;
  /** Historical win rate at this stage, 0–100. The forecast's weighting. */
  probability: number;
  isWon: boolean;
  isLost: boolean;
}

export interface Deal {
  id: string;
  title: string;
  /** Decimal crosses the wire as a STRING. See formatMoney. */
  value: string;
  currency: string;
  stageId: string;
  expectedCloseDate: string | null;
  closedAt: string | null;
  lostReason: string | null;
  aiWinProbability: number | null;
  aiInsight: string | null;
  customer: { id: string; name: string } | null;
  owner: { id: string; firstName: string; lastName: string } | null;
}

export interface BoardColumn {
  stage: PipelineStage;
  deals: Deal[];
  /** Every deal in the stage — not just the ones returned. See `hasMore`. */
  totalCount: number;
  totalValue: string;
  hasMore: boolean;
}

export interface Board {
  pipeline: { id: string; name: string };
  columns: BoardColumn[];
  weightedForecast: string;
}

export const dealKeys = {
  all: ['deals'] as const,
  board: () => ['deals', 'board'] as const,
};

export function useBoard() {
  return useQuery({
    queryKey: dealKeys.board(),
    queryFn: () => apiFetch<Board>('/crm/deals/board'),
  });
}

export interface MoveDealInput {
  dealId: string;
  stageId: string;
  lostReason?: string;
}

/**
 * Moves a deal to another stage, optimistically.
 *
 * A Kanban card that hangs in its old column for 300ms after you drop it feels
 * broken — the whole point of direct manipulation is that the object goes where
 * you put it. So the cache is rewritten *before* the request goes out, and rolled
 * back if the server disagrees.
 *
 * The rollback matters more than it looks. Without it, a rejected move (a stage
 * from another pipeline, a loss with no reason) leaves the card sitting in a
 * column the server never accepted — the UI now shows a deal state that does not
 * exist in the database, and the user has no way to know.
 */
export function useMoveDeal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ dealId, stageId, lostReason }: MoveDealInput) =>
      apiFetch<Deal>(`/crm/deals/${dealId}/move`, {
        method: 'POST',
        body: { stageId, lostReason },
      }),

    async onMutate({ dealId, stageId }) {
      // Stop any in-flight board refetch from landing on top of — and undoing —
      // the optimistic write we are about to make.
      await queryClient.cancelQueries({ queryKey: dealKeys.board() });

      const previous = queryClient.getQueryData<Board>(dealKeys.board());
      if (!previous) return { previous };

      const deal = previous.columns
        .flatMap((column) => column.deals)
        .find((candidate) => candidate.id === dealId);

      if (!deal) return { previous };

      const moved = { ...deal, stageId };

      queryClient.setQueryData<Board>(dealKeys.board(), {
        ...previous,
        columns: previous.columns.map((column) => {
          // Out of the old column…
          if (column.deals.some((candidate) => candidate.id === dealId)) {
            const deals = column.deals.filter((candidate) => candidate.id !== dealId);

            return {
              ...column,
              deals,
              // The header counts must move with the card, or the columns read
              // "3 deals" above two cards until the refetch lands.
              totalCount: Math.max(0, column.totalCount - 1),
              totalValue: String(Number(column.totalValue) - Number(deal.value)),
            };
          }

          // …and into the new one.
          if (column.stage.id === stageId) {
            return {
              ...column,
              deals: [moved, ...column.deals],
              totalCount: column.totalCount + 1,
              totalValue: String(Number(column.totalValue) + Number(deal.value)),
            };
          }

          return column;
        }),
      });

      return { previous };
    },

    onError(error, _input, context) {
      // Put the board back exactly as it was. The server refused the move, so
      // pretending it happened would be a lie the user cannot see through.
      if (context?.previous) {
        queryClient.setQueryData(dealKeys.board(), context.previous);
      }

      toast.error(error instanceof ApiRequestError ? error.message : 'Could not move the deal.');
    },

    onSettled() {
      // Whatever happened, re-sync with the server. The optimistic update is a
      // good guess — the weighted forecast, the AI probability and the closed
      // date are all recomputed server-side, and only the server knows them.
      void queryClient.invalidateQueries({ queryKey: dealKeys.all });
    },
  });
}

export function useCreateDeal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      title: string;
      value: number;
      customerId?: string;
      expectedCloseDate?: string;
    }) => apiFetch<Deal>('/crm/deals', { method: 'POST', body: input }),

    onSuccess: (deal) => {
      void queryClient.invalidateQueries({ queryKey: dealKeys.all });

      toast.success(`${deal.title} opened`, {
        description: 'AI is forecasting this deal in the background.',
      });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not open the deal.');
    },
  });
}
