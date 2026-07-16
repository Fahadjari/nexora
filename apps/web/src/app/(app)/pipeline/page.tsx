'use client';

import { Plus, Sparkles, Target, TrendingUp } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { Button, Card, EmptyState, Skeleton, cn } from '@/components/ui';
import { LostReasonDialog } from '@/features/deals/lost-reason-dialog';
import { NewDealDialog } from '@/features/deals/new-deal-dialog';
import {
  useBoard,
  useMoveDeal,
  type BoardColumn,
  type Deal,
  type PipelineStage,
} from '@/features/deals/use-deals';
import { formatMoney } from '@/features/leads/use-leads';
import { useAuthStore } from '@/lib/auth-store';

/**
 * A pending move that is waiting on a reason before it can be committed.
 *
 * Dragging to "Lost" cannot be applied immediately — the API demands a reason —
 * so the move is parked here while the dialog asks for one. Cancelling drops it,
 * and because nothing was written optimistically the card simply stays put.
 */
interface PendingLoss {
  deal: Deal;
  stageId: string;
}

function WinProbability({ probability, insight }: { probability: number | null; insight: string | null }) {
  if (probability === null) return null;

  const tone =
    probability >= 70
      ? 'bg-success/10 text-success'
      : probability >= 40
        ? 'bg-warning/10 text-warning'
        : 'bg-danger/10 text-danger';

  return (
    <span
      // The number is a claim; the insight is the evidence. A prediction with no
      // rationale is how users learn to distrust the AI.
      title={insight ?? undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular',
        tone,
      )}
    >
      <Sparkles className="h-3 w-3" />
      {probability}%
    </span>
  );
}

function DealCard({
  deal,
  stages,
  currentStageId,
  onMove,
  onDragStart,
  isDragging,
}: {
  deal: Deal;
  stages: PipelineStage[];
  currentStageId: string;
  onMove: (deal: Deal, stageId: string) => void;
  onDragStart: (deal: Deal) => void;
  isDragging: boolean;
}) {
  const overdue =
    deal.expectedCloseDate !== null &&
    deal.closedAt === null &&
    new Date(deal.expectedCloseDate) < new Date();

  return (
    <Card
      draggable
      onDragStart={() => onDragStart(deal)}
      className={cn(
        'cursor-grab space-y-2 p-3 transition-opacity active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-snug">{deal.title}</p>
        <WinProbability probability={deal.aiWinProbability} insight={deal.aiInsight} />
      </div>

      {deal.customer && <p className="text-[12px] text-subtle">{deal.customer.name}</p>}

      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold tabular">{formatMoney(deal.value)}</span>

        {overdue && (
          <span className="text-[11px] font-medium text-danger" title="The expected close date has passed">
            Overdue
          </span>
        )}
      </div>

      {/*
        The keyboard path.

        Native HTML5 drag-and-drop is mouse-only — there is no keyboard gesture
        for it, and a board that can ONLY be operated by dragging is unusable for
        anyone who does not use a mouse, and awkward on touch. This select does
        the same job, reachable by Tab, and it doubles as the obvious affordance
        on a phone. It is not a fallback bolted on for compliance; it is the
        second, equal way to move a deal.
      */}
      <select
        value={currentStageId}
        onChange={(event) => onMove(deal, event.target.value)}
        aria-label={`Move "${deal.title}" to another stage`}
        className="w-full rounded-md border border-border bg-canvas px-2 py-1 text-[12px] text-subtle transition-colors hover:border-subtle/40"
      >
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </select>
    </Card>
  );
}

function StageColumn({
  column,
  stages,
  draggingDealId,
  isDropTarget,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragLeave,
}: {
  column: BoardColumn;
  stages: PipelineStage[];
  draggingDealId: string | null;
  isDropTarget: boolean;
  onMove: (deal: Deal, stageId: string) => void;
  onDragStart: (deal: Deal) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: () => void;
  onDragLeave: () => void;
}) {
  const { stage } = column;

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-card border p-3 transition-colors',
        // The drop target has to be visible while dragging, or the user is
        // aiming at an invisible box and guessing.
        isDropTarget
          ? 'border-accent bg-accent-subtle/40'
          : 'border-transparent bg-muted/40',
      )}
    >
      <div className="mb-3 px-1">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            {stage.name}

            {stage.isWon && <TrendingUp className="h-3.5 w-3.5 text-success" />}
          </h2>

          <span className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-medium tabular text-subtle">
            {column.totalCount}
          </span>
        </div>

        <div className="mt-1 flex items-baseline justify-between">
          {/* The TRUE total for the stage, not the sum of the cards below —
              which are capped at 50. See BOARD_DEALS_PER_STAGE on the API. */}
          <span className="text-[12px] tabular text-subtle">{formatMoney(column.totalValue)}</span>

          {/* The stage's historical win rate. This is the number the forecast is
              weighted by, so showing it explains where the forecast comes from
              instead of asking the user to trust a black box. */}
          {!stage.isWon && !stage.isLost && (
            <span className="text-[11px] text-subtle/70" title="Historical win rate at this stage">
              {stage.probability}%
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-2">
        {column.deals.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            stages={stages}
            currentStageId={stage.id}
            onMove={onMove}
            onDragStart={onDragStart}
            isDragging={draggingDealId === deal.id}
          />
        ))}

        {column.deals.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-[12px] text-subtle/60">
            Drop a deal here
          </div>
        )}

        {/* Honesty about the cap. A column showing 50 of 312 cards must say so —
            otherwise the board quietly lies about what is in the pipeline. */}
        {column.hasMore && (
          <p className="pt-1 text-center text-[11px] text-subtle/70">
            Showing {column.deals.length} of {column.totalCount}
          </p>
        )}
      </div>
    </div>
  );
}

export default function PipelinePage() {
  const can = useAuthStore((state) => state.can);

  const { data: board, isLoading, isError, error } = useBoard();
  const moveDeal = useMoveDeal();

  const [dragging, setDragging] = useState<Deal | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingLoss, setPendingLoss] = useState<PendingLoss | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const stages = board?.columns.map((column) => column.stage) ?? [];
  const canCreate = can('crm.deal:create');

  /**
   * The single funnel every move goes through — drag-and-drop and the keyboard
   * select both land here, so the loss rule cannot be bypassed by using the
   * other one.
   */
  function requestMove(deal: Deal, stageId: string) {
    if (stageId === deal.stageId) return;

    const target = stages.find((stage) => stage.id === stageId);

    // A loss needs a reason before anything is written. Park the move and ask.
    if (target?.isLost) {
      setPendingLoss({ deal, stageId });
      return;
    }

    moveDeal.mutate({ dealId: deal.id, stageId });
  }

  function handleDrop(stageId: string) {
    setDropTarget(null);

    if (dragging) {
      requestMove(dragging, stageId);
      setDragging(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {board?.pipeline.name ?? 'Pipeline'}
          </h1>
          <p className="mt-0.5 text-[13px] text-subtle">
            Drag a deal to move it, or use the stage picker on any card.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/*
            The weighted forecast.

            The raw pipeline total is the number sales quotes and finance never
            believes, because it values a deal that arrived this morning the same
            as one out for signature. Weighting each stage by its historical win
            rate is the cheapest forecast that is not actively misleading — and
            it is the number worth putting at the top of the page.
          */}
          {board && (
            <Card className="flex items-center gap-2 px-3 py-2">
              <Target className="h-4 w-4 text-accent" />
              <div>
                <p className="text-[11px] leading-none text-subtle">Weighted forecast</p>
                <p className="mt-1 text-sm font-semibold leading-none tabular">
                  {formatMoney(board.weightedForecast)}
                </p>
              </div>
            </Card>
          )}

          {canCreate && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
              New deal
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-96 w-72 shrink-0" />
          ))}
        </div>
      ) : isError ? (
        <Card>
          <EmptyState
            title="Could not load the pipeline"
            description={
              error instanceof Error ? error.message : 'Something went wrong. Try again.'
            }
          />
        </Card>
      ) : board && board.columns.every((column) => column.totalCount === 0) ? (
        <Card>
          <EmptyState
            icon={<Target className="h-5 w-5" />}
            title="No deals in the pipeline"
            description="Open a deal directly, or convert a qualified lead — Nexora will create the deal and put it in the first stage for you."
            action={
              canCreate ? (
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
                  New deal
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        // Horizontal scroll lives on the board, never on the page body — a
        // dashboard whose whole window slides sideways feels broken.
        <div className="flex gap-4 overflow-x-auto pb-4">
          {board?.columns.map((column) => (
            <StageColumn
              key={column.stage.id}
              column={column}
              stages={stages}
              draggingDealId={dragging?.id ?? null}
              isDropTarget={dropTarget === column.stage.id}
              onMove={requestMove}
              onDragStart={setDragging}
              onDragOver={(event) => {
                // Without preventDefault the browser refuses the drop outright.
                // This one line is the entire reason HTML5 DnD "does not work"
                // for most people who try it.
                event.preventDefault();
                setDropTarget(column.stage.id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === column.stage.id ? null : current))}
              onDrop={() => handleDrop(column.stage.id)}
            />
          ))}
        </div>
      )}

      <NewDealDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      <LostReasonDialog
        open={pendingLoss !== null}
        dealTitle={pendingLoss?.deal.title}
        pending={moveDeal.isPending}
        // Cancelling abandons the move. Nothing was written, so the card is
        // already where it should be — there is nothing to undo.
        onCancel={() => setPendingLoss(null)}
        onConfirm={(lostReason) => {
          if (!pendingLoss) return;

          moveDeal.mutate({
            dealId: pendingLoss.deal.id,
            stageId: pendingLoss.stageId,
            lostReason,
          });

          setPendingLoss(null);
        }}
      />
    </div>
  );
}
