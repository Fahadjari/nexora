/**
 * Queue names and job payloads for the CRM module.
 *
 * Every payload carries `tenantId`. This is not redundant with the request
 * context — a worker runs long after the request that queued it has ended, in
 * a different process, with no async context to inherit. The tenant has to
 * travel *with* the job, and the processor re-establishes the scope from it.
 * A job without a tenantId would hit the Prisma extension's "no tenant in
 * context" guard and fail loudly, which is exactly the intended behaviour.
 */

export const LEAD_SCORING_QUEUE = 'crm.lead-scoring';

export interface ScoreLeadJob {
  leadId: string;
  tenantId: string;
}

export const DEAL_SCORING_QUEUE = 'crm.deal-scoring';

export interface ScoreDealJob {
  dealId: string;
  tenantId: string;
}
