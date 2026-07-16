import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from 'src/common/decorators/auth.decorators';
import { getContext } from 'src/common/context/request-context';
import type { AppConfig } from 'src/config/configuration';
import { MembershipCache } from '../membership-cache.service';
import type { AccessTokenPayload } from '../auth.types';

/**
 * Verifies the bearer token and populates the request context.
 *
 * Registered globally in `AppModule`, so every route is authenticated unless it
 * carries `@Public()`. Auth that is opt-out rather than opt-in means a new
 * endpoint is safe on the day it is written, and an omission is a 401 rather
 * than a breach.
 *
 * The token carries identity (`sub`, `tid`) but *not* permissions. Permissions
 * are resolved per request from the membership cache. That costs a Redis read
 * (~1ms), and buys immediate revocation: when an owner strips a role, the next
 * request reflects it. Baking permissions into a 15-minute token would leave a
 * fired employee with up to 15 minutes of live access — the wrong trade for a
 * system that holds a company's books.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly reflector: Reflector,
    private readonly membershipCache: MembershipCache,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);

    if (isPublic) return true;

    const request = executionContext.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.configService.get('JWT_ACCESS_SECRET', { infer: true }),
      });
    } catch {
      // Deliberately vague: distinguishing "expired" from "malformed" from
      // "wrong signature" tells an attacker which knob to turn.
      throw new UnauthorizedException('Invalid or expired token.');
    }

    // The token proves who the user is. It does not prove they still have a
    // seat in this workspace — that is a live question, so we ask it.
    const membership = await this.membershipCache.resolve(payload.sub, payload.tid);

    if (!membership) {
      throw new UnauthorizedException('Your access to this workspace has been removed.');
    }

    const context = getContext();
    if (context) {
      context.userId = payload.sub;
      context.tenantId = payload.tid;
      context.permissions = membership.permissions;
      context.isSuperAdmin = payload.sa === true;
    }

    // Kept for Passport-shaped code and for anything reading `req.user`.
    (request as Request & { user: unknown }).user = {
      userId: payload.sub,
      tenantId: payload.tid,
      email: payload.email,
      permissions: membership.permissions,
      isSuperAdmin: payload.sa === true,
    };

    return true;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;

    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
