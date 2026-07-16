import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { BILLING_MAINTENANCE_JOB, BILLING_MAINTENANCE_QUEUE } from './billing.queues';
import { SubscriptionService } from './subscription.service';

/**
 * Sweeps lapsed subscriptions into their true state, once an hour.
 *
 * A crucial thing to be clear about: **enforcement does not depend on this job.**
 * The `SubscriptionGuard` already refuses writes the instant `trialEndsAt`
 * passes, computed live from the clock on every request. A trial is locked at
 * second zero whether or not this worker ever runs.
 *
 * What this fixes is the *stored* status. Without it, an expired trial's row
 * still says `TRIALING` forever — so every "active trials" number in a report is
 * wrong, the admin console shows a ghost, and no dunning email ever fires because
 * nothing ever transitions the row. The guard protects revenue; this keeps the
 * books honest.
 *
 * It is deliberately idempotent and cheap: it only touches rows whose stored
 * status disagrees with the clock, so a run with nothing to do is two indexed
 * queries and out.
 */
@Injectable()
@Processor(BILLING_MAINTENANCE_QUEUE)
export class BillingMaintenanceProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(BillingMaintenanceProcessor.name);

  constructor(
    @InjectQueue(BILLING_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly subscriptions: SubscriptionService,
  ) {
    super();
  }

  /**
   * Registers the repeatable tick when the app boots.
   *
   * The job id is fixed, so re-registering on every restart replaces the
   * schedule rather than stacking a new one beside it — otherwise a service that
   * restarts ten times a day ends up with ten sweeps running at once.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      BILLING_MAINTENANCE_JOB,
      {},
      {
        repeat: { pattern: '0 * * * *' }, // top of every hour
        jobId: 'billing-maintenance-hourly',
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log('Scheduled hourly billing maintenance.');
  }

  async process(_job: Job): Promise<void> {
    const { expired } = await this.subscriptions.runMaintenance();

    if (expired > 0) {
      this.logger.log(`Maintenance expired ${expired} lapsed subscription(s).`);
    }
  }
}
