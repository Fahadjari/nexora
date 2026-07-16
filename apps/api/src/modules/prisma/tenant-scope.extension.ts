import { Prisma } from '@prisma/client';
import { getContext } from 'src/common/context/request-context';

/**
 * Models that carry a `tenantId` and must never be queried without one.
 *
 * Kept as an explicit list rather than inferred from the DMMF: adding a
 * tenant-scoped model should be a deliberate act. If you add a model with a
 * tenantId and forget to list it here, the isolation test in
 * `tenant-scope.extension.spec.ts` fails — it cross-checks this list against
 * the schema, so the omission cannot ship quietly.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'Membership',
  'Role',
  'AuditLog',
  'Lead',
  'Customer',
  'Contact',
  'Pipeline',
  'Deal',
  'Activity',
  'Note',
  'Subscription',
  'Invitation',
]);

/** Reads that should be filtered down to the caller's tenant. */
const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Writes that target existing rows, and so need a tenant filter in `where`. */
const TARGETED_WRITE_OPERATIONS = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/** Operations whose payload needs a tenantId stamped into it. */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Models that must NOT have `deletedAt: null` forced into their reads.
 *
 * Two different reasons land a model here, and both matter:
 *
 *   • AuditLog has a `deletedAt` column but is append-only — the trail is the
 *     one thing that must never be quietly filtered.
 *   • Subscription, Invitation and the rest simply have no `deletedAt` column
 *     at all. Injecting the filter would make Prisma throw on an unknown
 *     argument, and every read of them would fail.
 *
 * Nothing here is soft-deletable, so nothing here needs the filter. Add a model
 * to this list the moment you give it a tenantId without a deletedAt.
 */
const SOFT_DELETE_EXEMPT_MODELS = new Set<string>([
  'AuditLog',
  'Subscription',
  'Invitation',
]);

/**
 * The tenant isolation extension.
 *
 * Every query against a tenant-scoped model gets `tenantId` injected — into
 * `where` for reads and targeted writes, into `data` for creates. A query that
 * reaches this point with no tenant in context throws rather than returning
 * another workspace's rows.
 *
 * Two properties matter and are both load-bearing:
 *
 *   1. It is *not* possible to opt out by accident. Bypassing requires calling
 *      `runCrossTenant()`, which is greppable and reviewed.
 *   2. A caller who passes their own `tenantId` cannot use it to reach across
 *      the boundary — we overwrite it, and throw if it disagrees with context.
 *      Otherwise `findMany({ where: { tenantId: req.body.tenantId } })` would
 *      be an IDOR waiting to happen.
 *
 * Soft delete is handled here too: reads default to `deletedAt: null` unless
 * the caller says otherwise, so "deleted" rows stay invisible without every
 * service having to remember the filter.
 */
/**
 * The scoping decision, extracted from the Prisma plumbing.
 *
 * Separated so it can be unit-tested directly. `Prisma.defineExtension` returns
 * an opaque wrapper, not the hook itself, so a test cannot reach inside it —
 * and this rule is far too important to be verified only through integration
 * tests that need a live database to run.
 *
 * Mutates and returns `args` — the shape Prisma will actually execute.
 */
export function applyTenantScope(
  model: string,
  operation: string,
  args: unknown,
): Record<string, unknown> {
  const typedArgs = (args ?? {}) as Record<string, unknown>;

  if (!TENANT_SCOPED_MODELS.has(model)) {
    return typedArgs;
  }

  const context = getContext();

  // System code (seeds, platform admin, cross-tenant jobs) opts out
  // deliberately. Everything else must have a tenant.
  if (context?.allowCrossTenant) {
    return typedArgs;
  }

  const tenantId = context?.tenantId;
  if (!tenantId) {
    throw new Error(
      `Refusing to run ${model}.${operation} with no tenant in context. ` +
        `Either the route is missing its auth guard, or a background job ` +
        `forgot to wrap the work in runInTenant().`,
    );
  }

  if (READ_OPERATIONS.has(operation) || TARGETED_WRITE_OPERATIONS.has(operation)) {
    typedArgs.where = scopeWhere(typedArgs.where, tenantId, model, operation);
  }

  if (CREATE_OPERATIONS.has(operation)) {
    typedArgs.data = stampTenantOnData(typedArgs.data, tenantId);
  }

  if (operation === 'upsert') {
    typedArgs.where = scopeWhere(typedArgs.where, tenantId, model, operation);
    typedArgs.create = stampTenantOnData(typedArgs.create, tenantId);
  }

  return typedArgs;
}

export function createTenantScopeExtension() {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(applyTenantScope(model, operation, args));
        },
      },
    },
  });
}

/**
 * Forces `tenantId` into a where clause, and defaults the soft-delete filter.
 *
 * Relies on Prisma's extended-where-unique support (GA since Prisma 5), which
 * is what lets us add a non-unique `tenantId` to a `findUnique`/`update`/
 * `delete` where clause. Without it we would have to rewrite those into
 * `findFirst`/`updateMany`, which a query extension cannot do.
 */
function scopeWhere(
  where: unknown,
  tenantId: string,
  model: string,
  operation: string,
): Record<string, unknown> {
  const clause = (where ?? {}) as Record<string, unknown>;

  // A caller-supplied tenantId that disagrees with the session is either a bug
  // or an attack. Refuse loudly instead of silently overwriting, so we find out
  // which.
  const supplied = clause.tenantId;
  if (typeof supplied === 'string' && supplied !== tenantId) {
    throw new Error(
      `Cross-tenant access denied: ${model}.${operation} asked for tenant ` +
        `${supplied} while the request belongs to tenant ${tenantId}.`,
    );
  }

  clause.tenantId = tenantId;

  // Hide soft-deleted rows by default. An explicit `deletedAt` in the query
  // means the caller is deliberately asking about deletion state — respect it.
  const isRead = READ_OPERATIONS.has(operation);
  if (isRead && !SOFT_DELETE_EXEMPT_MODELS.has(model) && !('deletedAt' in clause)) {
    clause.deletedAt = null;
  }

  return clause;
}

/** Stamps tenantId onto a create payload, single or batch. */
function stampTenantOnData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => ({ ...(row as object), tenantId }));
  }
  if (data && typeof data === 'object') {
    return { ...(data as object), tenantId };
  }
  return data;
}
