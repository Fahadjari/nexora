import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  REQUIRED_PERMISSIONS_KEY,
  SUPER_ADMIN_ONLY_KEY,
} from 'src/common/decorators/auth.decorators';
import { getContext } from 'src/common/context/request-context';
import { WILDCARD_PERMISSION, type Permission } from 'src/modules/rbac/permissions';

/**
 * Enforces `@RequirePermissions(...)`.
 *
 * Runs after `JwtAuthGuard`, so the context is already populated. A route with
 * no `@RequirePermissions` is merely authenticated — fine for things like
 * "read my own profile", but any route touching business data should declare
 * what it needs.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(executionContext: ExecutionContext): boolean {
    const handler = executionContext.getHandler();
    const controller = executionContext.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller])) {
      return true;
    }

    const context = getContext();
    const superAdminOnly = this.reflector.getAllAndOverride<boolean>(SUPER_ADMIN_ONLY_KEY, [
      handler,
      controller,
    ]);

    if (superAdminOnly && !context?.isSuperAdmin) {
      throw new ForbiddenException('This endpoint is restricted to platform administrators.');
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS_KEY, [
      handler,
      controller,
    ]);

    if (!required || required.length === 0) return true;

    const held = context?.permissions ?? [];

    if (held.includes(WILDCARD_PERMISSION)) return true;

    const missing = required.filter((permission) => !held.includes(permission));

    if (missing.length > 0) {
      // Naming the missing permission is not a leak — the caller already knows
      // what they tried to do — and it turns a support ticket into a one-liner
      // an owner can act on.
      throw new ForbiddenException(
        `You do not have permission to do this. Missing: ${missing.join(', ')}.`,
      );
    }

    return true;
  }
}
