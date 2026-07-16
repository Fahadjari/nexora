import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, LeadStatus, Prisma, type Lead } from '@prisma/client';
import { Queue } from 'bullmq';
import { getContext, requireTenantId } from 'src/common/context/request-context';
import { PaginatedResponse, resolveSort } from 'src/common/dto/pagination.dto';
import { TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { LEAD_SCORING_QUEUE, type ScoreLeadJob } from '../crm.queues';
import type { ConvertLeadDto, CreateLeadDto, LeadQueryDto, UpdateLeadDto } from './dto/lead.dto';

/** Columns a client may sort by. Anything else is ignored — see resolveSort. */
const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'aiScore', 'estimatedValue', 'lastName'] as const;

/**
 * Of those, the ones that are actually nullable in the schema.
 *
 * This distinction is load-bearing: Prisma accepts `orderBy: { field: { sort,
 * nulls } }` ONLY for nullable columns, and throws a validation error for
 * required ones. So `nulls: 'last'` has to be applied selectively rather than
 * blanket-applied to every sort — which is exactly the bug the e2e tests caught.
 */
const NULLABLE_SORT_FIELDS = new Set<string>(['aiScore', 'estimatedValue']);

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    // The tenant-scoped client. Note the total absence of `tenantId` in the
    // queries below — the Prisma extension injects it. That is not laziness;
    // it is the isolation guarantee. A query here *cannot* reach another
    // workspace's rows even if this code is wrong.
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @InjectQueue(LEAD_SCORING_QUEUE) private readonly scoringQueue: Queue<ScoreLeadJob>,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateLeadDto): Promise<Lead> {
    const context = getContext();

    const lead = await this.db.lead.create({
      data: {
        ...dto,
        // Unowned leads get forgotten. Default to whoever created it.
        ownerId: dto.ownerId ?? context?.userId ?? null,
        estimatedValue: dto.estimatedValue ?? null,
      } as Prisma.LeadUncheckedCreateInput,
    });

    await this.audit.record({
      action: AuditAction.CREATE,
      resource: 'Lead',
      resourceId: lead.id,
      metadata: { name: `${lead.firstName} ${lead.lastName}` },
    });

    // Score out of band. Calling the model inline would put a multi-second
    // network round trip inside a POST that should return in milliseconds, and
    // would fail the user's create if the provider were down.
    await this.enqueueScoring(lead.id);

    return lead;
  }

  async findMany(query: LeadQueryDto): Promise<PaginatedResponse<Lead>> {
    const where: Prisma.LeadWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.minScore !== undefined ? { aiScore: { gte: query.minScore } } : {}),
      ...(query.search ? this.searchFilter(query.search) : {}),
    };

    const sortBy = resolveSort(query.sortBy, SORTABLE_FIELDS, 'createdAt');

    const [data, total] = await Promise.all([
      this.db.lead.findMany({
        where,
        orderBy: this.buildOrderBy(sortBy, query.sortOrder),
        skip: query.skip,
        take: query.limit,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        },
      }),
      this.db.lead.count({ where }),
    ]);

    return new PaginatedResponse(data, total, query);
  }

  async findOne(id: string): Promise<Lead> {
    const lead = await this.db.lead.findFirst({
      where: { id },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        activities: { orderBy: { createdAt: 'desc' }, take: 20 },
        notes: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });

    // Note this is a genuine 404 even when the row exists in another tenant —
    // the scoping extension filtered it out before we got here. Telling the
    // caller "exists, but not yours" would leak the existence of other
    // companies' records.
    if (!lead) {
      throw new NotFoundException('Lead not found.');
    }

    return lead;
  }

  async update(id: string, dto: UpdateLeadDto): Promise<Lead> {
    const before = await this.findOne(id);

    const lead = await this.db.lead.update({
      where: { id },
      data: dto as Prisma.LeadUncheckedUpdateInput,
    });

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Lead',
      resourceId: id,
      changes: this.audit.diff(
        before as unknown as Record<string, unknown>,
        dto as Record<string, unknown>,
      ),
    });

    // Re-score only when something the model actually reasons about has moved.
    // Re-scoring on every keystroke-level edit would burn tokens for nothing.
    if (this.affectsScore(dto)) {
      await this.enqueueScoring(id);
    }

    return lead;
  }

  /**
   * Soft delete. The row stays, `deletedAt` is set, and the Prisma extension
   * hides it from every subsequent read.
   *
   * SMBs delete things by accident constantly, and a lead carries a history of
   * calls and notes that is genuinely painful to lose. Nothing here is worth a
   * hard DELETE.
   */
  async remove(id: string): Promise<void> {
    await this.findOne(id);

    await this.db.lead.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({ action: AuditAction.DELETE, resource: 'Lead', resourceId: id });
  }

  /**
   * Turns a qualified lead into a customer, and optionally opens a deal.
   *
   * All-or-nothing: a crash midway must not leave a customer with no deal and a
   * lead that thinks it was converted. One transaction, or nothing.
   */
  async convert(id: string, dto: ConvertLeadDto): Promise<{ customerId: string; dealId?: string }> {
    const lead = await this.findOne(id);

    if (lead.status === LeadStatus.CONVERTED) {
      // Idempotency guard. Double-clicking "Convert" should not silently create
      // a second customer for the same person.
      throw new BadRequestException('This lead has already been converted.');
    }

    const tenantId = requireTenantId();

    return this.db.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          tenantId,
          name: dto.customerName ?? lead.companyName ?? `${lead.firstName} ${lead.lastName}`,
          email: lead.email,
          phone: lead.phone,
          ownerId: lead.ownerId,
        },
      });

      // Carry the person across as the primary contact — otherwise the customer
      // record arrives with nobody to call, which is how conversions get lost.
      await tx.contact.create({
        data: {
          tenantId,
          customerId: customer.id,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
          jobTitle: lead.jobTitle,
          isPrimary: true,
        },
      });

      let dealId: string | undefined;

      if (dto.dealTitle) {
        const pipeline = await tx.pipeline.findFirst({
          where: { tenantId, isDefault: true, deletedAt: null },
          include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
        });

        if (!pipeline?.stages[0]) {
          throw new BadRequestException(
            'No default pipeline is configured, so the deal cannot be created.',
          );
        }

        const deal = await tx.deal.create({
          data: {
            tenantId,
            title: dto.dealTitle,
            value: dto.dealValue ?? lead.estimatedValue ?? 0,
            pipelineId: pipeline.id,
            stageId: pipeline.stages[0].id,
            customerId: customer.id,
            ownerId: lead.ownerId,
          },
        });

        dealId = deal.id;
      }

      await tx.lead.update({
        where: { id },
        data: {
          status: LeadStatus.CONVERTED,
          convertedCustomerId: customer.id,
          convertedAt: new Date(),
        },
      });

      await this.audit.record({
        action: AuditAction.UPDATE,
        resource: 'Lead',
        resourceId: id,
        metadata: { converted: true, customerId: customer.id, dealId },
      });

      this.logger.log(`Lead ${id} converted to customer ${customer.id}`);

      return { customerId: customer.id, dealId };
    });
  }

  /** Lets a user demand a fresh score — after enriching a lead by hand, say. */
  async requestRescore(id: string): Promise<void> {
    await this.findOne(id);
    await this.enqueueScoring(id);
  }

  /**
   * Case-insensitive search across the fields a rep would actually type.
   *
   * `mode: 'insensitive'` maps to ILIKE, which cannot use a plain btree index.
   * That is fine at SMB list sizes; when a tenant's lead table gets large enough
   * to feel it, this becomes a Postgres full-text or trigram index rather than a
   * wider LIKE.
   */
  private searchFilter(search: string): Prisma.LeadWhereInput {
    const contains = { contains: search, mode: Prisma.QueryMode.insensitive };

    return {
      OR: [
        { firstName: contains },
        { lastName: contains },
        { email: contains },
        { companyName: contains },
        { phone: contains },
      ],
    };
  }

  /**
   * Builds the `orderBy` clause, adding `nulls: 'last'` only where it is legal.
   *
   * It matters for `aiScore`: Postgres sorts NULLs *first* on a descending sort,
   * so without this every unscored lead would sit above the hottest one — the
   * exact opposite of what "sort by score, best first" means to a salesperson.
   *
   * But passing `nulls` for a non-nullable column is a Prisma validation error,
   * so required fields get the plain sort form.
   */
  private buildOrderBy(
    sortBy: string,
    sortOrder: 'asc' | 'desc',
  ): Prisma.LeadOrderByWithRelationInput {
    if (NULLABLE_SORT_FIELDS.has(sortBy)) {
      return { [sortBy]: { sort: sortOrder, nulls: 'last' } } as Prisma.LeadOrderByWithRelationInput;
    }

    return { [sortBy]: sortOrder } as Prisma.LeadOrderByWithRelationInput;
  }

  /** True when an edit changes something the scoring prompt actually reads. */
  private affectsScore(dto: UpdateLeadDto): boolean {
    const scoringInputs: (keyof UpdateLeadDto)[] = [
      'email',
      'phone',
      'companyName',
      'jobTitle',
      'status',
      'source',
      'estimatedValue',
    ];

    return scoringInputs.some((field) => dto[field] !== undefined);
  }

  /**
   * Queues a scoring job.
   *
   * The job carries `tenantId` explicitly because a worker runs outside any
   * request — there is no async context for it to inherit, so it must
   * re-establish the tenant scope itself (see the processor's `runInTenant`).
   *
   * Failing to enqueue is logged, never thrown: the lead has already been saved
   * and the user's work is done. A missing score is a nuisance; a 500 on a
   * successful create is a bug.
   */
  private async enqueueScoring(leadId: string): Promise<void> {
    try {
      await this.scoringQueue.add(
        'score-lead',
        { leadId, tenantId: requireTenantId() },
        {
          // Collapse repeat edits: if a rep saves four times in a minute, the
          // lead is scored once, not four times.
          //
          // Hyphens, not colons — BullMQ uses `:` internally as its Redis key
          // separator and rejects custom job ids containing one.
          jobId: `score-lead-${leadId}`,
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Could not queue scoring for lead ${leadId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
