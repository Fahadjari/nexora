import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { getContext } from '../context/request-context';

/** The shape every error response takes. The web client depends on it. */
export interface ErrorResponseBody {
  statusCode: number;
  /** Stable machine-readable code, e.g. `VALIDATION_FAILED`. */
  code: string;
  message: string;
  /** Field-level detail for form errors. */
  details?: Record<string, string[]>;
  requestId: string;
  timestamp: string;
  path: string;
}

/**
 * Turns everything thrown anywhere in the app into one consistent JSON shape.
 *
 * The important job here is not formatting — it is making sure internal detail
 * never reaches the client. A Prisma error message quotes the failing SQL and
 * column names; a stack trace maps our source layout. Both go to the log, where
 * we can correlate by requestId; the caller gets a generic message and that id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = getContext()?.requestId ?? 'unknown';

    const { status, code, message, details } = this.translate(exception);

    const body: ErrorResponseBody = {
      statusCode: status,
      code,
      message,
      ...(details ? { details } : {}),
      requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    // 5xx means we broke something: log the whole exception with a stack.
    // 4xx means the caller did; log it thin so real failures stay visible.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status} ${code} [${requestId}]`);
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: Record<string, string[]>;
  } {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        message: 'The request body failed validation.',
        details: this.flattenZodIssues(exception),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }

    // Anything else is a bug. Say nothing useful to the caller.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Quote the request id if you contact support.',
    };
  }

  private fromHttpException(exception: HttpException): {
    status: number;
    code: string;
    message: string;
    details?: Record<string, string[]>;
  } {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { status, code: this.statusToCode(status), message: payload };
    }

    const record = payload as Record<string, unknown>;
    const rawMessage = record.message;

    // Nest's ValidationPipe hands us `message: string[]` — one entry per failed
    // constraint. Fold those into the details map so the client can attach them
    // to fields instead of dumping a list.
    if (Array.isArray(rawMessage)) {
      return {
        status,
        code: 'VALIDATION_FAILED',
        message: 'The request body failed validation.',
        details: { _errors: rawMessage.map(String) },
      };
    }

    return {
      status,
      code: (record.code as string) ?? this.statusToCode(status),
      message: (rawMessage as string) ?? exception.message,
    };
  }

  private fromPrismaError(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: string;
    message: string;
  } {
    switch (exception.code) {
      case 'P2002': {
        // Unique constraint. Naming the field is safe and genuinely helpful.
        const target = exception.meta?.target;
        const field = Array.isArray(target) ? target.join(', ') : 'field';
        return {
          status: HttpStatus.CONFLICT,
          code: 'DUPLICATE_RECORD',
          message: `A record with that ${field} already exists.`,
        };
      }
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'The requested record does not exist.',
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'INVALID_REFERENCE',
          message: 'The request references a record that does not exist.',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'DATABASE_ERROR',
          message: 'A database error occurred.',
        };
    }
  }

  /** Groups Zod issues by the field path so a form can render them inline. */
  private flattenZodIssues(error: ZodError): Record<string, string[]> {
    const details: Record<string, string[]> = {};

    for (const issue of error.issues) {
      const path = issue.path.join('.') || '_errors';
      (details[path] ??= []).push(issue.message);
    }

    return details;
  }

  private statusToCode(status: number): string {
    const map: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
      [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
    };
    return map[status] ?? 'ERROR';
  }
}
