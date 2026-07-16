import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { getContext, runCrossTenant } from 'src/common/context/request-context';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import {
  PaginatedResponse,
  PaginationQueryDto,
} from 'src/common/dto/pagination.dto';

export interface AuditEntry {
  action: AuditAction;
  /** Entity type, e.g. `Lead`. */
  resource: string;
  resourceId?: string;
  /** Overrides the actor from the request context — used by background jobs. */
  userId?: string;
  /** Field-level before/after. Redacted before it is written. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Fields whose values must never reach the audit table.
 *
 * The audit log is the one table we deliberately never delete from and often
 * export for compliance — which makes it the worst possible place for a
 * password hash or a TOTP secret to end up. Matching is on the key name, case-
 * insensitively and by substring, so `newPassword` and `twoFactorSecret` are
 * both caught.
 */
const REDACTED_FIELDS = [
  'password',
  'passwordhash',
  'token',
  'secret',
  'apikey',
  'authorization',
  'creditcard',
  'cvv',
];

const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Writes the append-only trail of who did what.
 *
 * Two properties are deliberate:
 *
 *   • Writes never throw into the caller. An audit failure must not roll back a
 *     legitimate business action — losing one log line is bad, but refusing a
 *     customer's invoice because the log table was briefly unavailable is
 *     worse. Failures are logged loudly for alerting instead.
 *   • Writes bypass tenant scoping deliberately, because `AuditLog.tenantId` is
 *     nullable: failed logins happen before we know which workspace the person
 *     was aiming at, and those are exactly the events worth recording.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Records an action attributed to the current request's user and tenant. */
  async record(entry: AuditEntry): Promise<void> {
    const context = getContext();

    await this.write({
      tenantId: context?.tenantId ?? null,
      userId: entry.userId ?? context?.userId ?? null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? null,
      changes: this.asJson(this.redact(entry.changes)),
      metadata: this.asJson(this.redact(entry.metadata)),
      ipAddress: entry.ipAddress ?? context?.ipAddress ?? null,
      userAgent: entry.userAgent ?? context?.userAgent ?? null,
    });
  }

  /**
   * Records an event with no authenticated actor — a failed login, most often.
   * These matter: a burst of them is the signal that someone is being attacked.
   */
  async recordAnonymous(entry: AuditEntry): Promise<void> {
    await this.write({
      tenantId: null,
      userId: entry.resourceId ?? null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? null,
      changes: undefined,
      metadata: this.asJson(this.redact(entry.metadata)),
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  /**
   * Diffs two versions of a record and returns only what actually changed.
   *
   * Called by update paths so the log says "status: NEW → QUALIFIED" rather
   * than dumping the whole row, which would make the history unreadable and
   * balloon the table.
   */
  diff<T extends Record<string, unknown>>(
    before: T,
    after: Partial<T>,
  ): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const [key, nextValue] of Object.entries(after)) {
      const previousValue = before[key];

      if (nextValue === undefined) continue;

      // Compare structurally: Date and Decimal are objects, so `!==` would call
      // every untouched date a change and make every diff pure noise.
      if (JSON.stringify(this.normalize(previousValue)) !== JSON.stringify(this.normalize(nextValue))) {
        changes[key] = { from: this.normalize(previousValue), to: this.normalize(nextValue) };
      }
    }

    return changes;
  }

  /** Reads the trail. Requires `audit:read`, enforced at the controller. */
  async list(
    query: PaginationQueryDto & { resource?: string; resourceId?: string; userId?: string },
  ): Promise<PaginatedResponse<Prisma.AuditLogGetPayload<{ include: { user: true } }>>> {
    const context = getContext();

    const where: Prisma.AuditLogWhereInput = {
      tenantId: context?.tenantId,
      ...(query.resource ? { resource: query.resource } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };

    const [rows, total] = await Promise.all([
      runCrossTenant(() =>
        this.prisma.auditLog.findMany({
          where,
          include: { user: true },
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.limit,
        }),
      ),
      runCrossTenant(() => this.prisma.auditLog.count({ where })),
    ]);

    return new PaginatedResponse(rows, total, query);
  }

  /**
   * Hands a redacted object to Prisma as JSON.
   *
   * The cast is unavoidable and safe. Prisma's `InputJsonValue` demands
   * JSON-compatible leaves, but our inputs are `Record<string, unknown>` —
   * TypeScript cannot prove `unknown` is serialisable, even though everything
   * we actually pass (diffs and metadata) is. `redact()` has already walked the
   * structure, so anything exotic would have been caught there.
   */
  private asJson(value: unknown): Prisma.InputJsonValue | undefined {
    return value === undefined ? undefined : (value as Prisma.InputJsonValue);
  }

  private async write(data: Prisma.AuditLogUncheckedCreateInput): Promise<void> {
    try {
      await runCrossTenant(() => this.prisma.auditLog.create({ data }));
    } catch (error) {
      // Swallow, but shout. Alerting should page on this: an audit log that has
      // quietly stopped writing is worse than one that never existed, because
      // people trust it.
      this.logger.error(
        `Failed to write audit entry (${data.action} ${data.resource}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Strips sensitive values, recursively, before anything is persisted.
   *
   * Returns `undefined` rather than `null` for absent values: Prisma's nullable
   * Json columns do not accept a bare `null` (that would be ambiguous between
   * "JSON null" and "SQL NULL" — hence its `JsonNull` / `DbNull` sentinels).
   * `undefined` means "don't set this column", which is what we actually want.
   */
  private redact<T>(value: T): T | undefined {
    if (value === undefined || value === null) return undefined;

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item)) as T;
    }

    if (typeof value === 'object' && !(value instanceof Date)) {
      const output: Record<string, unknown> = {};

      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        const isSensitive = REDACTED_FIELDS.some((field) => key.toLowerCase().includes(field));
        output[key] = isSensitive ? REDACTION_PLACEHOLDER : this.redact(nested);
      }

      return output as T;
    }

    return value;
  }

  /** Flattens Prisma's Decimal and Date into JSON-comparable primitives. */
  private normalize(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Prisma.Decimal) return value.toString();
    return value;
  }
}
