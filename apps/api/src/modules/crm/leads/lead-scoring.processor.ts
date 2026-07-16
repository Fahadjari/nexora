import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import type { Job } from 'bullmq';
import { runInTenant } from 'src/common/context/request-context';
import { TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { LEAD_SCORING_QUEUE, type ScoreLeadJob } from '../crm.queues';
import { LeadScoringService } from './lead-scoring.service';

/**
 * Scores leads in the background.
 *
 * The one genuinely subtle thing here is `runInTenant`. A worker process has no
 * HTTP request and therefore no AsyncLocalStorage context — so the tenant-scoped
 * Prisma client would refuse every query with "no tenant in context". We
 * re-establish the scope from the job payload, and everything inside the callback
 * behaves exactly as it would inside a request.
 *
 * That refusal is a feature: it means a background job physically cannot query
 * across tenants by forgetting to filter. It fails instead.
 */
@Processor(LEAD_SCORING_QUEUE, {
  // Model calls are slow and rate-limited, not CPU-bound. Five at a time keeps
  // the queue moving without tripping provider rate limits on a busy tenant.
  concurrency: 5,
})
export class LeadScoringProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadScoringProcessor.name);

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    private readonly scoring: LeadScoringService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job<ScoreLeadJob>): Promise<void> {
    const { leadId, tenantId } = job.data;

    await runInTenant(tenantId, async () => {
      const lead = await this.db.lead.findFirst({ where: { id: leadId } });

      // The lead may have been deleted between enqueue and execution. That is
      // normal, not an error — drop the job quietly rather than retrying three
      // times against a row that is never coming back.
      if (!lead) {
        this.logger.debug(`Lead ${leadId} no longer exists; skipping scoring.`);
        return;
      }

      const result = await this.scoring.score(lead);

      // No score available (AI disabled, provider down, or the model declined).
      // Leave the existing score alone and let the next edit re-trigger. Writing
      // a null over a previously good score would be worse than doing nothing.
      if (!result) {
        this.logger.debug(`No score produced for lead ${leadId}; leaving it as-is.`);
        return;
      }

      await this.db.lead.update({
        where: { id: leadId },
        data: {
          aiScore: result.score,
          aiScoreReason: result.reason,
          aiScoredAt: new Date(),
        },
      });

      // Attribute the write to the machine, not to whoever last touched the
      // lead — otherwise the audit trail claims a salesperson set their own score.
      await this.audit.record({
        action: AuditAction.AI_ACTION,
        resource: 'Lead',
        resourceId: leadId,
        userId: undefined,
        metadata: {
          score: result.score,
          suggestedNextAction: result.suggestedNextAction,
        },
      });

      this.logger.log(`Lead ${leadId} scored ${result.score}/100`);
    });
  }
}
