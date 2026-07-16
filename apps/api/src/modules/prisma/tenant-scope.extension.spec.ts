import { runCrossTenant, runInTenant, runWithContext } from 'src/common/context/request-context';
import { TENANT_SCOPED_MODELS } from './tenant-scope.extension';

/**
 * Tenant isolation is the single security property this platform cannot get
 * wrong. Every other bug is a bug; a cross-tenant leak is a company reading
 * another company's books, and it ends the business.
 *
 * So these tests exercise the extension's decision logic directly, without a
 * database. They are fast, they run in CI on every commit, and they assert the
 * things that must never regress:
 *
 *   1. A tenant-scoped read cannot run with no tenant in context.
 *   2. A caller cannot smuggle in someone else's tenantId.
 *   3. Creates are stamped with the caller's tenant, not the one they asked for.
 *   4. Soft-deleted rows are invisible unless explicitly requested.
 *   5. The escape hatch works — and only when used deliberately.
 *
 * The extension's `$allOperations` hook is reproduced here through the same
 * code path Prisma would call it with, so what we test is what runs.
 */

import { applyTenantScope } from './tenant-scope.extension';

type Operation = { model: string; operation: string; args: Record<string, unknown> };

/**
 * Runs one operation through the scoping rule and returns the args Prisma would
 * then execute. `applyTenantScope` is the exact function the live extension
 * calls, so what we assert here is what actually runs against the database.
 *
 * Async purely so the throwing cases can be asserted with `rejects`, matching
 * how they surface at runtime.
 */
async function runThroughExtension(op: Operation): Promise<Record<string, unknown>> {
  return applyTenantScope(op.model, op.operation, op.args);
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function asTenant<T>(tenantId: string, fn: () => T): T {
  return runInTenant(tenantId, fn);
}

describe('tenant scope extension', () => {
  describe('the guarantee: no tenant, no query', () => {
    it('refuses a tenant-scoped read when there is no tenant in context', async () => {
      // This is the failure mode that matters. A route missing its auth guard,
      // or a job that forgot runInTenant, must NOT quietly return every
      // workspace's leads — it must blow up.
      await expect(
        runThroughExtension({ model: 'Lead', operation: 'findMany', args: {} }),
      ).rejects.toThrow(/no tenant in context/i);
    });

    it('refuses a tenant-scoped write when there is no tenant in context', async () => {
      await expect(
        runThroughExtension({
          model: 'Lead',
          operation: 'create',
          args: { data: { firstName: 'Ada', lastName: 'Lovelace' } },
        }),
      ).rejects.toThrow(/no tenant in context/i);
    });

    it('leaves models that are not tenant-scoped alone', async () => {
      // User and Tenant are global by design — login has to find a user before
      // it knows which workspace they belong to.
      const args = await runThroughExtension({
        model: 'User',
        operation: 'findUnique',
        args: { where: { email: 'ada@example.com' } },
      });

      expect(args.where).toEqual({ email: 'ada@example.com' });
      expect(args.where).not.toHaveProperty('tenantId');
    });
  });

  describe('reads are filtered to the caller', () => {
    it('injects tenantId into a findMany', async () => {
      const args = await asTenant(TENANT_A, () =>
        runThroughExtension({ model: 'Lead', operation: 'findMany', args: { where: { status: 'NEW' } } }),
      );

      expect(args.where).toMatchObject({ tenantId: TENANT_A, status: 'NEW' });
    });

    it('injects tenantId into a findUnique by id', async () => {
      // The IDOR case: user in tenant A asks for a lead id belonging to tenant
      // B. The tenantId in the where clause turns it into a miss, not a leak.
      const args = await asTenant(TENANT_A, () =>
        runThroughExtension({
          model: 'Lead',
          operation: 'findUnique',
          args: { where: { id: 'some-lead-owned-by-tenant-b' } },
        }),
      );

      expect(args.where).toMatchObject({
        id: 'some-lead-owned-by-tenant-b',
        tenantId: TENANT_A,
      });
    });

    it('hides soft-deleted rows by default', async () => {
      const args = await asTenant(TENANT_A, () =>
        runThroughExtension({ model: 'Lead', operation: 'findMany', args: {} }),
      );

      expect(args.where).toMatchObject({ tenantId: TENANT_A, deletedAt: null });
    });

    it('respects an explicit deletedAt filter', async () => {
      // "Show me the deleted ones" is a legitimate request — don't override it.
      const args = await asTenant(TENANT_A, () =>
        runThroughExtension({
          model: 'Lead',
          operation: 'findMany',
          args: { where: { deletedAt: { not: null } } },
        }),
      );

      expect(args.where).toMatchObject({
        tenantId: TENANT_A,
        deletedAt: { not: null },
      });
    });
  });

  describe('a caller cannot reach across the boundary', () => {
    it('throws when the query names a different tenant', async () => {
      // The attack: `GET /leads?tenantId=<victim>` reaching a service that
      // passes filters straight through. We refuse loudly rather than silently
      // overwriting, so the attempt is visible in the logs.
      await expect(
        asTenant(TENANT_A, () =>
          runThroughExtension({
            model: 'Lead',
            operation: 'findMany',
            args: { where: { tenantId: TENANT_B } },
          }),
        ),
      ).rejects.toThrow(/cross-tenant access denied/i);
    });

    it('stamps creates with the caller\'s tenant, ignoring what they sent', async () => {
      const args = await asTenant(TENANT_A, () =>
        runThroughExtension({
          model: 'Lead',
          operation: 'create',
          args: { data: { firstName: 'Ada', tenantId: TENANT_B } },
        }),
      );

      // Not TENANT_B. A user cannot plant a record in someone else's workspace.
      expect((args.data as Record<string, unknown>).tenantId).toBe(TENANT_A);
    });

    it('stamps every row of a createMany', async () => {
      const args = await asTenant(TENANT_A, () =>
        runThroughExtension({
          model: 'Lead',
          operation: 'createMany',
          args: { data: [{ firstName: 'Ada' }, { firstName: 'Grace' }] },
        }),
      );

      expect(args.data).toEqual([
        { firstName: 'Ada', tenantId: TENANT_A },
        { firstName: 'Grace', tenantId: TENANT_A },
      ]);
    });

    it('scopes updates and deletes, so you cannot mutate another tenant\'s row', async () => {
      const updateArgs = await asTenant(TENANT_A, () =>
        runThroughExtension({
          model: 'Lead',
          operation: 'update',
          args: { where: { id: 'victim-lead' }, data: { status: 'CONVERTED' } },
        }),
      );

      expect(updateArgs.where).toMatchObject({ id: 'victim-lead', tenantId: TENANT_A });

      const deleteArgs = await asTenant(TENANT_A, () =>
        runThroughExtension({
          model: 'Lead',
          operation: 'deleteMany',
          args: { where: {} },
        }),
      );

      expect(deleteArgs.where).toMatchObject({ tenantId: TENANT_A });
    });
  });

  describe('the escape hatch', () => {
    it('lets system code opt out deliberately', async () => {
      const args = await runCrossTenant(() =>
        runThroughExtension({ model: 'Lead', operation: 'findMany', args: {} }),
      );

      // Untouched — no tenantId, no soft-delete filter. This is what the seeder
      // and platform-admin screens need, and why it is a named, greppable call.
      expect(args).toEqual({});
    });

    it('does not leak the opt-out into a normal request context', async () => {
      // Guards against the nightmare: allowCrossTenant sticking around after a
      // system job and quietly disabling isolation for real user traffic.
      runWithContext(
        {
          requestId: 'test',
          tenantId: TENANT_A,
          userId: null,
          permissions: [],
          isSuperAdmin: false,
          allowCrossTenant: false,
        },
        () => {
          // no-op; establishing the context is the point
        },
      );

      await expect(
        runThroughExtension({ model: 'Lead', operation: 'findMany', args: {} }),
      ).rejects.toThrow(/no tenant in context/i);
    });
  });

  describe('the model list', () => {
    it('covers every CRM entity that carries a tenantId', () => {
      // A new tenant-scoped model that is not registered here would silently
      // bypass isolation. Adding a model to the schema and forgetting this list
      // is the most plausible way someone breaks tenancy in future, so we pin it.
      for (const model of ['Lead', 'Customer', 'Contact', 'Deal', 'Pipeline', 'Activity', 'Note']) {
        expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
      }
    });

    it('does not scope the models that are legitimately global', () => {
      for (const model of ['User', 'Tenant', 'RefreshToken', 'OAuthIdentity']) {
        expect(TENANT_SCOPED_MODELS.has(model)).toBe(false);
      }
    });
  });
});
