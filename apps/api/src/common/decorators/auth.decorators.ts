import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from 'src/modules/rbac/permissions';
import { getContext } from '../context/request-context';

export const IS_PUBLIC_KEY = 'isPublic';
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const SUPER_ADMIN_ONLY_KEY = 'superAdminOnly';

/**
 * Opts a route out of authentication.
 *
 * `JwtAuthGuard` is registered globally, so auth is on by default and a new
 * endpoint is protected the moment it exists. Forgetting a decorator therefore
 * fails closed. Every use of this one is a deliberate hole and should read like
 * one in review.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Requires the caller to hold *every* listed permission.
 *
 * All-of rather than any-of: an endpoint that both reads a customer and writes
 * a deal needs both rights, and "any" would be the wrong default to have to
 * remember to override.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/** Restricts a route to Nexora staff — platform administration, not tenant work. */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_ONLY_KEY, true);

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  permissions: string[];
  isSuperAdmin: boolean;
}

/**
 * Injects the authenticated caller into a handler.
 *
 * Reads from the async context rather than `request.user` so that it returns
 * the same object a service would see — one source of truth for "who is this".
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, _ctx: ExecutionContext) => {
    const context = getContext();

    if (!context?.userId || !context.tenantId) {
      // Only reachable if someone puts @CurrentUser on a @Public route.
      throw new Error('@CurrentUser used on a route that is not authenticated.');
    }

    const user: AuthenticatedUser = {
      userId: context.userId,
      tenantId: context.tenantId,
      email: '', // filled by JwtAuthGuard from the token claims
      permissions: context.permissions,
      isSuperAdmin: context.isSuperAdmin,
    };

    return field ? user[field] : user;
  },
);

/** Shorthand for the common case of only needing the tenant id. */
export const CurrentTenant = createParamDecorator((_data: unknown, _ctx: ExecutionContext) => {
  const tenantId = getContext()?.tenantId;
  if (!tenantId) {
    throw new Error('@CurrentTenant used on a route that is not tenant-scoped.');
  }
  return tenantId;
});
