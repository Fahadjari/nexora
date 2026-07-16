import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import type { Job } from 'bullmq';
import { runInTenant } from 'src/common/context/request-context';
import { AuditService } from 'src/modules/audit/audit.service';
import { TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import { DEAL_SCORING_QUEUE, type ScoreDealJob } from '../crm.queues';
import { DealScoringService, type ScorableDeal } from './deal-scoring.service';

/**
 * Predicts deal outcomes in the background.
 *
 * `runInTenant` re-establishes the tenant scope from the job payload: a worker
 * has no HTTP request, therefore no AsyncLocalStorage context, and the scoped
 * Prisma client would refuse every query without it. That refusal is the point —
 * a background job cannot silently query across tenants by forgetting to filter.
 */
@Processor(DEAL_SCORING_QUEUE, { concurrency: 5 })
export class DealScoringProcessor extends WorkerHost {
  private readonly logger = new Logger(DealScoringProcessor.name);

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    private readonly scoring: DealScoringService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job<ScoreDealJob>): Promise<void> {
    const { dealId, tenantId } = job.data;

    await runInTenant(tenantId, async () => {
      const deal = await this.db.deal.findFirst({
        where: { id: dealId },
        include: { stage: true },
      });

      // Deleted between enqueue and execution. Normal, not an error — drop the
      // job rather than retrying three times against a row that is gone.
      if (!deal) {
        this.logger.debug(`Deal ${dealId} no longer exists; skipping prediction.`);
        return;
      }

      // It may also have been *closed* in that window — a rep dragging a deal to
      // Won right after editing it is an entirely ordinary race. Forecasting a
      // deal whose outcome is already known is a waste of tokens.
      if (deal.stage.isWon || deal.stage.isLost) {
        this.logger.debug(`Deal ${dealId} is already closed; skipping prediction.`);
        return;
      }

      const result = await this.scoring.predict(deal as ScorableDeal);

      // No prediction available (AI off, provider down, model declined). Leave
      // the previous one alone — writing a null over a good prediction is worse
      // than doing nothing.
      if (!result) {
        this.logger.debug(`No prediction produced for deal ${dealId}; leaving it as-is.`);
        return;
      }

      await this.db.deal.update({
        where: { id: dealId },
        data: {
          aiWinProbability: result.winProbability,
          aiInsight: result.insight,
          aiScoredAt: new Date(),
        },
      });

      // Attributed to the machine, not to whoever last touched the deal —
      // otherwise the trail claims a salesperson set their own win probability.
      await this.audit.record({
        action: AuditAction.AI_ACTION,
        resource: 'Deal',
        resourceId: dealId,
        userId: undefined,
        metadata: { winProbability: result.winProbability },
      });

      this.logger.log(`Deal ${dealId} predicted ${result.winProbability}% to win`);
    });
  }
}
