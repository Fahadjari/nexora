import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/auth.decorators';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { runCrossTenant } from 'src/common/context/request-context';
import { BillingExempt } from './billing.decorators';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment.types';
import { SubscriptionService } from './subscription.service';

/**
 * Where the payment provider tells us what happened.
 *
 * This endpoint is public, unauthenticated, and it mutates billing state. That
 * combination is only safe because of three things, and removing any one of them
 * makes it a way for a stranger to award themselves a free subscription:
 *
 *   1. **The signature is verified over the raw bytes** before anything is read.
 *      An unsigned webhook is an anonymous internet user with write access to
 *      your revenue.
 *   2. **Every event is recorded, and the id is unique.** Providers retry, and
 *      they deliver out of order and more than once — that is the documented
 *      contract, not a fault. Processing `subscription.charged` twice would
 *      extend a subscription twice.
 *   3. **We always answer 200.** A non-2xx tells the provider to retry, so an
 *      unhandled event type — or a bug in our handler — would have Razorpay
 *      hammering this endpoint for days. We acknowledge receipt, then deal with
 *      the contents on our own terms.
 */
@ApiExcludeController()
@Public()
@BillingExempt()
@Controller('billing/webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    private readonly subscriptions: SubscriptionService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string,
    @Headers('x-razorpay-event-id') eventId: string,
  ): Promise<{ received: true }> {
    const rawBody = request.rawBody;

    if (!rawBody) {
      // Means `rawBody: true` was dropped from the Nest bootstrap. Fail loudly:
      // silently falling back to the parsed body would make every signature
      // check fail, and the "fix" someone reaches for is to stop checking.
      this.logger.error('No raw body on the webhook request. Is `rawBody: true` set in main.ts?');
      throw new BadRequestException('Malformed webhook.');
    }

    if (!this.payments.verifyWebhook(rawBody, signature)) {
      this.logger.warn('Rejected a webhook with a bad signature.');
      throw new UnauthorizedException('Invalid signature.');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    const event = this.payments.parseEvent(payload);

    // Razorpay puts the event id in a header, not the body. Prefer it; fall back
    // to the deterministic key the adapter built, so idempotency never depends on
    // a header that might not arrive.
    const idempotencyKey = eventId || event.id;

    try {
      // The insert IS the idempotency check. Two concurrent deliveries of the
      // same event race here, and the unique index means exactly one wins — which
      // is a guarantee a `findFirst`-then-`create` cannot make, because both
      // callers would read "not found" before either wrote.
      await runCrossTenant(() =>
        this.prisma.webhookEvent.create({
          data: {
            provider: this.payments.name,
            providerEventId: idempotencyKey,
            type: event.type,
            payload: payload as Prisma.InputJsonValue,
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' // unique violation
      ) {
        this.logger.debug(`Duplicate webhook ${idempotencyKey}; already handled.`);
        return { received: true };
      }

      throw error;
    }

    try {
      await this.subscriptions.applyEvent(event);

      await runCrossTenant(() =>
        this.prisma.webhookEvent.updateMany({
          where: { provider: this.payments.name, providerEventId: idempotencyKey },
          data: { processedAt: new Date() },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Store the failure and still answer 200. The row stays with a null
      // `processedAt` and an error on it — replayable, and visible to anyone
      // asking "which payments did we drop?". Making the provider retry would
      // just replay the same bug against the same row.
      this.logger.error(`Failed to apply webhook ${idempotencyKey}: ${message}`);

      await runCrossTenant(() =>
        this.prisma.webhookEvent.updateMany({
          where: { provider: this.payments.name, providerEventId: idempotencyKey },
          data: { error: message },
        }),
      );
    }

    return { received: true };
  }
}
