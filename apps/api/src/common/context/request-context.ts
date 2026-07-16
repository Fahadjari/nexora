import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Everything the request "is" — who, which workspace, what they may do.
 *
 * Held in AsyncLocalStorage rather than passed down through every service
 * signature. The point is not convenience: it is that the Prisma extension
 * (which sits below the service layer and cannot be handed a parameter) needs
 * the tenant id on *every* query. Threading it by hand means one forgotten
 * argument is a cross-tenant data leak. Storing it in the async context makes
 * the safe path the only path.
 */
export interface RequestContext {
  /** Correlates logs, audit rows and error responses for one request. */
  requestId: string;

  /** The workspace this request operates in. Null only for unauthenticated
   *  routes and for platform-level super-admin work. */
  tenantId: string | null;

  userId: string | null;

  /** Resolved from the user's role in *this* tenant. `['*']` means everything. */
  permissions: string[];

  isSuperAdmin: boolean;

  /**
   * Escape hatch that lets a query touch tenant-scoped tables without a
   * tenantId — needed by the seeder, cross-tenant platform admin screens and
   * scheduled jobs that sweep all workspaces.
   *
   * Never set from an HTTP handler based on user input. Grant it only in code
   * that has already decided, on its own authority, that crossing the boundary
   * is correct: see `runCrossTenant()`.
   */
  allowCrossTenant: boolean;

  ipAddress?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` visible to everything it awaits. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active context, or undefined outside any request (e.g. at boot). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The active tenant id, or null. Callers that require a tenant should use
 * `requireTenantId()` so the failure is loud.
 */
export function getTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

export function requireTenantId(): string {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new Error(
      'No tenant in the request context. A tenant-scoped operation ran outside ' +
        'a tenant — this is a bug, not a user error.',
    );
  }
  return tenantId;
}

export function getUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

/**
 * Runs `fn` with tenant scoping switched off.
 *
 * Reach for this only in system code — the seeder, platform admin queries, and
 * background sweeps across all tenants. Anything reachable from a user request
 * must not call it.
 */
export function runCrossTenant<T>(fn: () => T): T {
  const current = storage.getStore();
  const context: RequestContext = {
    requestId: current?.requestId ?? 'system',
    tenantId: null,
    userId: current?.userId ?? null,
    permissions: current?.permissions ?? [],
    isSuperAdmin: current?.isSuperAdmin ?? false,
    allowCrossTenant: true,
  };
  return storage.run(context, fn);
}

/**
 * Runs `fn` inside a specific tenant. Used by queue workers, which pick up a
 * job carrying a tenantId and must re-establish the scope the producer had.
 */
export function runInTenant<T>(tenantId: string, fn: () => T, userId: string | null = null): T {
  const context: RequestContext = {
    requestId: `job:${tenantId}`,
    tenantId,
    userId,
    permissions: ['*'],
    isSuperAdmin: false,
    allowCrossTenant: false,
  };
  return storage.run(context, fn);
}
