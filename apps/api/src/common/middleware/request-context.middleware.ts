import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from '../context/request-context';

/**
 * Opens the AsyncLocalStorage scope for the request.
 *
 * Runs before guards, so at this point we have no user yet — the context starts
 * anonymous and `JwtAuthGuard` fills in the identity once the token is verified.
 * Everything downstream (services, the Prisma extension, the logger) reads from
 * the object this establishes.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Honour an upstream correlation id if a gateway or the web app set one, so
    // a trace survives across service hops.
    const requestId =
      (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    const context: RequestContext = {
      requestId,
      tenantId: null,
      userId: null,
      permissions: [],
      isSuperAdmin: false,
      allowCrossTenant: false,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    };

    res.setHeader('x-request-id', requestId);

    runWithContext(context, () => next());
  }
}
