import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public, RequirePermissions } from 'src/common/decorators/auth.decorators';
import { PERMISSIONS } from 'src/modules/rbac/permissions';
import { BillingExempt } from './billing.decorators';
import { ChangeSeatsDto, CreateCheckoutDto } from './dto/billing.dto';
import { PURCHASABLE_PLANS } from './plans';
import { SubscriptionService } from './subscription.service';

/**
 * Billing.
 *
 * The entire controller is `@BillingExempt`, and that is the single most
 * important line in it. Without it, a customer whose trial expired could not
 * reach the page that lets them subscribe — the subscription lock would refuse
 * the request, and the lock that exists to *drive* the sale would be the thing
 * preventing it. A locked-out customer must always be able to give you money.
 */
@ApiTags('Billing')
@ApiBearerAuth()
@BillingExempt()
@Controller('billing')
export class BillingController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Get('plans')
  @Public()
  @ApiOperation({
    summary: 'The plans on sale',
    description:
      'Public, because it is the pricing page. Prices are per seat, per month, in paise.',
  })
  plans() {
    return PURCHASABLE_PLANS.map((plan) => ({
      key: plan.key,
      name: plan.name,
      tagline: plan.tagline,
      pricePerSeatMonthly: plan.pricePerSeatMonthly,
      defaultSeats: plan.defaultSeats,
      features: plan.features,
    }));
  }

  @Get('subscription')
  // Deliberately NOT gated on `tenant:billing`. Everyone in the workspace should
  // be able to see "your trial ends in 3 days" — hiding it from the sales rep who
  // is about to lose access, and showing it only to the owner who is on holiday,
  // is how a trial lapses without anyone noticing.
  @ApiOperation({ summary: 'This workspace\'s subscription, entitlements and seat usage' })
  current() {
    return this.subscriptions.current();
  }

  @Post('checkout')
  @RequirePermissions(PERMISSIONS.TENANT_BILLING)
  @ApiOperation({
    summary: 'Start a subscription',
    description:
      'Returns a URL to send the customer to. The subscription is NOT active when this ' +
      'returns — only the provider\'s webhook may mark it paid.',
  })
  @ApiResponse({ status: 503, description: 'Payments are not configured on this deployment.' })
  checkout(@Body() dto: CreateCheckoutDto) {
    return this.subscriptions.createCheckout(dto.plan, dto.seats);
  }

  @Patch('seats')
  @RequirePermissions(PERMISSIONS.TENANT_BILLING)
  @ApiOperation({
    summary: 'Change the seat count',
    description: 'Charged pro-rata immediately. Cannot drop below the number of people you have.',
  })
  changeSeats(@Body() dto: ChangeSeatsDto) {
    return this.subscriptions.changeSeats(dto.seats);
  }

  @Delete('subscription')
  @RequirePermissions(PERMISSIONS.TENANT_BILLING)
  @ApiOperation({
    summary: 'Cancel',
    description:
      'Takes effect at the end of the period already paid for — not immediately. They ' +
      'bought the month; they get the month.',
  })
  cancel() {
    return this.subscriptions.cancel();
  }
}
