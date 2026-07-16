import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditModule } from 'src/modules/audit/audit.module';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { DEAL_SCORING_QUEUE, LEAD_SCORING_QUEUE } from './crm.queues';
import { DealScoringProcessor } from './deals/deal-scoring.processor';
import { DealScoringService } from './deals/deal-scoring.service';
import { DealsController } from './deals/deals.controller';
import { DealsService } from './deals/deals.service';
import { PipelinesService } from './deals/pipelines.service';
import { LeadScoringProcessor } from './leads/lead-scoring.processor';
import { LeadScoringService } from './leads/lead-scoring.service';
import { LeadsController } from './leads/leads.controller';
import { LeadsService } from './leads/leads.service';

/**
 * The CRM slice.
 *
 * This is the template the other modules (Sales, Inventory, Purchase, HR…) get
 * cloned from. The pattern each one repeats:
 *
 *   • Controllers are thin and declare their permissions. No logic.
 *   • Services take TENANT_DB, never the raw Prisma client.
 *   • Slow or optional work — anything involving a model — goes on a queue and
 *     never blocks the user's request.
 *   • AI failures are non-fatal by construction.
 */
@Module({
  imports: [
    AuditModule,
    BullModule.registerQueue({ name: LEAD_SCORING_QUEUE }, { name: DEAL_SCORING_QUEUE }),
  ],
  controllers: [LeadsController, CustomersController, DealsController],
  providers: [
    LeadsService,
    LeadScoringService,
    LeadScoringProcessor,
    CustomersService,
    DealsService,
    DealScoringService,
    DealScoringProcessor,
    PipelinesService,
  ],
  exports: [LeadsService, CustomersService, DealsService],
})
export class CrmModule {}
