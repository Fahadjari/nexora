import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getContext } from 'src/common/context/request-context';
import { IS_PUBLIC_KEY } from 'src/common/decorators/auth.decorators';
import { BILLING_EXEMPT_KEY, REQUIRED_FEATURE_KEY } from '../billing.decorators';
import { EntitlementsService } from '../entitlements.service';
import { PLANS, type Feature } from '../plans';

/** Methods that only read. These are never blocked by a billing lock. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Turns a subscription into an enforced one.
 *
 * Registered globally, immediately after `JwtAuthGuard` — so a plan is enforced
 * on every route the day it is written, and forgetting a decorator fails
 * *closed*. The same discipline as auth, for the same reason: the alternative is
 * remembering to add a check to two hundred endpoints, and remembering is not a
 * control.
 *
 * The shape of the enforcement is the important part:
 *
 *   • **Reads are never blocked.** A customer whose trial lapsed can still open
 *     the app, look at their customers, and export them. They cannot add new
 *     ones.
 *   • **Writes are refused with 402 Payment Required** — a status code that
 *     exists for precisely this and is almost never used. Not 403: this is not
 *     "you may not", it is "not yet paid for", and the client renders an upgrade
 *     prompt rather than a dead error.
 *   • **Billing and auth routes are exempt**, because a locked customer must be
 *     able to log in and pay. A lock that blocks the payment that would lift it
 *     is not a business model, it is a bug.
 *
 * That combination is what makes it commercially effective without being
 * hostile: an ERP you cannot write to is useless within a day, so the pressure
 * to subscribe is real — but the company's data is never held hostage, which is
 * the line between a firm product and an extortionate one.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const handler = executionContext.getHandler();
    const controller = executionContext.getClass();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller]);
    const isExempt = this.reflector.getAllAndOverride<boolean>(BILLING_EXEMPT_KEY, [
      handler,
      controller,
    ]);

    if (isPublic || isExempt) return true;

    const context = getContext();
    const tenantId = context?.tenantId;

    // No tenant means JwtAuthGuard already rejected this, or the route is not
    // tenant-scoped. Either way there is no subscription to enforce.
    if (!tenantId) return true;

    // Nexora staff are not customers and have no plan. They are constrained by
    // @SuperAdminOnly wherever it matters.
    if (context?.isSuperAdmin) return true;

    const entitlements = await this.entitlements.forTenant(tenantId);

    // A feature gate is about the *company's plan*, not the user's role — hence a
    // 402 with an upgrade path rather than a 403. Enforced on reads too: a
    // Starter tenant should not be able to GET an AI insight it never paid to
    // generate.
    const requiredFeature = this.reflector.getAllAndOverride<Feature>(REQUIRED_FEATURE_KEY, [
      handler,
      controller,
    ]);

    if (requiredFeature && !entitlements.features.includes(requiredFeature)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'FEATURE_NOT_IN_PLAN',
          message:
            `Your ${PLANS[entitlements.plan].name} plan does not include this. ` +
            'Upgrade to unlock it.',
          feature: requiredFeature,
          currentPlan: entitlements.plan,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // A platform suspension is our decision about them, not a lapsed card — so it
    // is a 403 and it outranks the subscription. Offering a fraudster a
    // "Subscribe" button would be a strange way to end an abuse investigation.
    if (entitlements.suspended) {
      throw new ForbiddenException(
        'This workspace has been suspended. Please contact support — your data is safe.',
      );
    }

    const request = executionContext.switchToHttp().getRequest<Request>();

    // Reads always pass. This is the promise that makes the lock defensible:
    // whatever happens with their card, a company can always see its own books.
    if (SAFE_METHODS.has(request.method)) return true;

    if (!entitlements.canWrite) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'SUBSCRIPTION_REQUIRED',
          message: entitlements.lockedReason ?? 'A subscription is required to make changes.',
          subscriptionStatus: entitlements.status,
          // The client reads this to render "Subscribe" instead of an error.
          canWrite: false,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
