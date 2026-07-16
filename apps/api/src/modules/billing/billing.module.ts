import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AuditModule } from 'src/modules/audit/audit.module';
import { BillingController } from './billing.controller';
import { BILLING_MAINTENANCE_QUEUE } from './billing.queues';
import { BillingMaintenanceProcessor } from './billing-maintenance.processor';
import { EntitlementsService } from './entitlements.service';
import { PAYMENT_PROVIDER } from './payment.types';
import { RazorpayProvider } from './providers/razorpay.provider';
import { SubscriptionService } from './subscription.service';
import { WebhookController } from './webhook.controller';

/**
 * Billing.
 *
 * `@Global` for one reason: `EntitlementsService` is consumed by the
 * `SubscriptionGuard`, which is registered globally in `AppModule`. A global
 * guard cannot inject from a non-global module, so the service it depends on has
 * to be reachable everywhere. It also lets `MembersModule` check seat limits and
 * `AuthModule` start a trial without re-importing.
 *
 * The payment provider is bound to its interface here, and nowhere else. Swapping
 * Razorpay for Stripe is this one line — `useClass: StripeProvider` — plus a new
 * adapter file. Nothing outside `providers/` names a vendor, which is the whole
 * point of the abstraction: the day you sell in a second country, billing logic
 * does not move.
 */
@Global()
@Module({
  imports: [
    AuditModule,
    BullModule.registerQueue({ name: BILLING_MAINTENANCE_QUEUE }),
  ],
  controllers: [BillingController, WebhookController],
  providers: [
    SubscriptionService,
    EntitlementsService,
    BillingMaintenanceProcessor,
    {
      provide: PAYMENT_PROVIDER,
      useClass: RazorpayProvider,
    },
  ],
  exports: [SubscriptionService, EntitlementsService],
})
export class BillingModule {}
