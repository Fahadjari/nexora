import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, type Deal, type PipelineStage } from '@prisma/client';
import { Queue } from 'bullmq';
import { getContext, requireTenantId } from 'src/common/context/request-context';
import { PaginatedResponse, resolveSort } from 'src/common/dto/pagination.dto';
import { AuditService } from 'src/modules/audit/audit.service';
import { TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import { DEAL_SCORING_QUEUE, type ScoreDealJob } from '../crm.queues';
import type { CreateDealDto, DealQueryDto, MoveDealDto, UpdateDealDto } from './dto/deal.dto';

const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'value',
  'expectedCloseDate',
  'aiWinProbability',
  'title',
] as const;

/** Prisma accepts the `{ sort, nulls }` order form only on nullable columns. */
const NULLABLE_SORT_FIELDS = new Set<string>(['expectedCloseDate', 'aiWinProbability']);

/**
 * How many deals a single board column returns.
 *
 * The board is a UI, not an export. A tenant with 4,000 open deals must not be
 * able to make one page load pull 4,000 rows — so each column is capped, while
 * the column *header* still reports the true count and value from an aggregate.
 * The user sees "Proposal · 312 deals · ₹2.4 Cr" above 50 cards, which is honest;
 * showing "50" there because that is all we fetched would be a lie.
 */
const BOARD_DEALS_PER_STAGE = 50;

/** A stage column: the stage, its top deals, and the truth about the rest. */
export interface BoardColumn {
  stage: PipelineStage;
  deals: Deal[];
  /** Every deal in this stage, not just the ones returned. */
  totalCount: number;
  /** Summed value of every deal in this stage, as a string (see formatMoney). */
  totalValue: string;
  /** True when `deals` is a truncated view of `totalCount`. */
  hasMore: boolean;
}

export interface Board {
  pipeline: { id: string; name: string };
  columns: BoardColumn[];
  /**
   * Open pipeline value weighted by each stage's historical win rate.
   *
   * The unweighted sum is the number sales teams quote and finance never
   * believes, because it counts a deal that just entered qualification the same
   * as one out for signature. Weighting by stage probability is the cheapest
   * forecast that is not actively misleading.
   */
  weightedForecast: string;
}

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @InjectQueue(DEAL_SCORING_QUEUE) private readonly scoringQueue: Queue<ScoreDealJob>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Opens a deal.
   *
   * Both `pipelineId` and `stageId` are optional: the overwhelmingly common case
   * is "new deal, default pipeline, first stage", and making a caller look both
   * of those up before they can create anything is friction with no payoff.
   */
  async create(dto: CreateDealDto): Promise<Deal> {
    const context = getContext();
    const { pipelineId, stageId } = await this.resolveStartingStage(dto);

    const deal = await this.db.deal.create({
      data: {
        title: dto.title,
        value: dto.value,
        currency: dto.currency ?? 'INR',
        expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null,
        pipelineId,
        stageId,
        customerId: dto.customerId ?? null,
        ownerId: dto.ownerId ?? context?.userId ?? null,
      } as Prisma.DealUncheckedCreateInput,
    });

    await this.audit.record({
      action: AuditAction.CREATE,
      resource: 'Deal',
      resourceId: deal.id,
      metadata: { title: deal.title, value: deal.value.toString() },
    });

    await this.enqueueScoring(deal.id);

    return deal;
  }

  async findMany(query: DealQueryDto): Promise<PaginatedResponse<Deal>> {
    const where: Prisma.DealWhereInput = {
      ...(query.pipelineId ? { pipelineId: query.pipelineId } : {}),
      ...(query.stageId ? { stageId: query.stageId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.minWinProbability !== undefined
        ? { aiWinProbability: { gte: query.minWinProbability } }
        : {}),
      // "Open" is a property of the *stage*, not the deal — so it is a relation
      // filter rather than a column. Keeping the terminal flags on the stage is
      // what lets a tenant rename "Won" without breaking the definition of open.
      ...(query.openOnly ? { stage: { isWon: false, isLost: false } } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { customer: { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
        : {}),
    };

    const sortBy = resolveSort(query.sortBy, SORTABLE_FIELDS, 'createdAt');

    const [data, total] = await Promise.all([
      this.db.deal.findMany({
        where,
        orderBy: this.buildOrderBy(sortBy, query.sortOrder),
        skip: query.skip,
        take: query.limit,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          customer: { select: { id: true, name: true } },
          stage: { select: { id: true, name: true, probability: true, isWon: true, isLost: true } },
        },
      }),
      this.db.deal.count({ where }),
    ]);

    return new PaginatedResponse(data, total, query);
  }

  async findOne(id: string): Promise<Deal> {
    const deal = await this.db.deal.findFirst({
      where: { id },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        customer: { select: { id: true, name: true, email: true, phone: true } },
        stage: true,
        pipeline: { select: { id: true, name: true } },
        activities: { orderBy: { createdAt: 'desc' }, take: 20 },
        notes: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });

    if (!deal) {
      throw new NotFoundException('Deal not found.');
    }

    return deal;
  }

  async update(id: string, dto: UpdateDealDto): Promise<Deal> {
    const before = await this.findOne(id);

    const deal = await this.db.deal.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.expectedCloseDate !== undefined
          ? { expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null }
          : {}),
      } as Prisma.DealUncheckedUpdateInput,
    });

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Deal',
      resourceId: id,
      changes: this.audit.diff(
        before as unknown as Record<string, unknown>,
        dto as Record<string, unknown>,
      ),
    });

    // The value and the close date are the two things the win-probability model
    // weighs most heavily. A retitle is not worth a token.
    if (dto.value !== undefined || dto.expectedCloseDate !== undefined) {
      await this.enqueueScoring(id);
    }

    return deal;
  }

  /**
   * Moves a deal to another stage — the drag-and-drop on the board.
   *
   * This is the one write in the module that carries real business meaning, so
   * it is the one that gets the rules:
   *
   *   • The target stage must belong to the deal's own pipeline. Without this
   *     check a deal could be dragged into a stage of an entirely different
   *     process and the board would simply stop showing it.
   *   • Entering a won or lost stage stamps `closedAt`. Nothing else does.
   *   • A loss demands a reason. "Why did we lose?" answered at the moment of
   *     the loss is worth something; reconstructed from memory a month later it
   *     is worth nothing, and it is the only training signal the loss model has.
   *   • Re-opening a closed deal clears `closedAt` and the loss reason, because
   *     a deal that is open again was not, in fact, closed.
   */
  async move(id: string, dto: MoveDealDto): Promise<Deal> {
    const deal = await this.findOne(id);

    // PipelineStage has no `tenantId` of its own — it inherits isolation from
    // its pipeline — so it is not in TENANT_SCOPED_MODELS and this query is NOT
    // automatically filtered. The `pipelineId` constraint is therefore doing
    // real security work, not just validation: `deal` came back tenant-scoped,
    // so pinning the stage to that deal's pipeline is what makes it impossible
    // to move a deal into another company's stage. Dropping it would be a
    // cross-tenant write.
    const stage = await this.db.pipelineStage.findFirst({
      where: { id: dto.stageId, pipelineId: deal.pipelineId },
    });

    if (!stage) {
      throw new BadRequestException('That stage does not belong to this deal\'s pipeline.');
    }

    if (stage.id === deal.stageId) {
      // A drag that lands where it started. Not an error — just nothing to do,
      // and certainly not worth an audit entry claiming the deal moved.
      return deal;
    }

    if (stage.isLost && !dto.lostReason) {
      throw new BadRequestException('Tell us why the deal was lost — the reason is required.');
    }

    const isClosing = stage.isWon || stage.isLost;

    const updated = await this.db.deal.update({
      where: { id },
      data: {
        stageId: stage.id,
        closedAt: isClosing ? new Date() : null,
        lostReason: stage.isLost ? (dto.lostReason ?? null) : null,
      },
    });

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Deal',
      resourceId: id,
      metadata: {
        movedFrom: deal.stageId,
        movedTo: stage.id,
        stageName: stage.name,
        ...(stage.isWon ? { won: true, value: deal.value.toString() } : {}),
        ...(stage.isLost ? { lost: true, lostReason: dto.lostReason } : {}),
      },
    });

    this.logger.log(`Deal ${id} moved to "${stage.name}"`);

    // A closed deal has no future to predict. Re-scoring one would spend tokens
    // to answer a question that has already been answered by reality.
    if (!isClosing) {
      await this.enqueueScoring(id);
    }

    return updated;
  }

  /**
   * The Kanban board: every stage of a pipeline, with its deals.
   *
   * Deliberately not `findMany` grouped in the client. The column headers need
   * the *true* count and value of each stage — which is an aggregate over rows
   * we are not returning — and the forecast needs every open deal's value
   * weighted by its stage. Both are aggregates, and doing them in Postgres is
   * one round trip instead of a full table transfer.
   */
  async board(pipelineId?: string): Promise<Board> {
    const pipeline = await this.db.pipeline.findFirst({
      where: pipelineId ? { id: pipelineId } : { isDefault: true },
      include: { stages: { orderBy: { position: 'asc' } } },
    });

    if (!pipeline) {
      throw new NotFoundException(
        pipelineId ? 'Pipeline not found.' : 'This workspace has no default pipeline.',
      );
    }

    // One aggregate for the whole board, rather than one per column.
    const totals = await this.db.deal.groupBy({
      by: ['stageId'],
      where: { pipelineId: pipeline.id },
      _count: { _all: true },
      _sum: { value: true },
    });

    const totalByStage = new Map(totals.map((row) => [row.stageId, row]));

    // One capped page of cards per column. Stage counts are small (a handful),
    // so this is a handful of indexed queries, run concurrently.
    const dealsByStage = await Promise.all(
      pipeline.stages.map((stage) =>
        this.db.deal.findMany({
          where: { stageId: stage.id },
          orderBy: { value: 'desc' },
          take: BOARD_DEALS_PER_STAGE,
          include: {
            owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
            customer: { select: { id: true, name: true } },
          },
        }),
      ),
    );

    let weighted = new Prisma.Decimal(0);

    const columns: BoardColumn[] = pipeline.stages.map((stage, index) => {
      const aggregate = totalByStage.get(stage.id);
      const totalCount = aggregate?._count._all ?? 0;
      const totalValue = aggregate?._sum.value ?? new Prisma.Decimal(0);

      // Only open stages contribute to the forecast. A won deal is revenue, not
      // a prediction; a lost one is nothing. Adding either to a *forecast* would
      // be double-counting the past.
      if (!stage.isWon && !stage.isLost) {
        weighted = weighted.plus(totalValue.times(stage.probability).dividedBy(100));
      }

      return {
        stage,
        deals: dealsByStage[index],
        totalCount,
        totalValue: totalValue.toString(),
        hasMore: totalCount > dealsByStage[index].length,
      };
    });

    return {
      pipeline: { id: pipeline.id, name: pipeline.name },
      columns,
      weightedForecast: weighted.toFixed(2),
    };
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);

    await this.db.deal.update({ where: { id }, data: { deletedAt: new Date() } });

    await this.audit.record({ action: AuditAction.DELETE, resource: 'Deal', resourceId: id });
  }

  /** Lets a user demand a fresh win prediction. */
  async requestRescore(id: string): Promise<void> {
    await this.findOne(id);
    await this.enqueueScoring(id);
  }

  /**
   * Works out which pipeline and stage a new deal starts in.
   *
   * The pairing is validated rather than assumed: a caller may pass a stage from
   * pipeline A and a pipeline id of B, and the database would happily store that
   * contradiction — the deal would then be invisible on both boards.
   */
  private async resolveStartingStage(
    dto: CreateDealDto,
  ): Promise<{ pipelineId: string; stageId: string }> {
    const pipeline = await this.db.pipeline.findFirst({
      where: dto.pipelineId ? { id: dto.pipelineId } : { isDefault: true },
      include: { stages: { orderBy: { position: 'asc' } } },
    });

    if (!pipeline) {
      throw new BadRequestException(
        dto.pipelineId
          ? 'That pipeline does not exist.'
          : 'This workspace has no default pipeline, so there is nowhere to put the deal.',
      );
    }

    if (pipeline.stages.length === 0) {
      throw new BadRequestException(`Pipeline "${pipeline.name}" has no stages.`);
    }

    if (!dto.stageId) {
      return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
    }

    const stage = pipeline.stages.find((candidate) => candidate.id === dto.stageId);

    if (!stage) {
      throw new BadRequestException('That stage does not belong to the chosen pipeline.');
    }

    return { pipelineId: pipeline.id, stageId: stage.id };
  }

  private buildOrderBy(
    sortBy: string,
    sortOrder: 'asc' | 'desc',
  ): Prisma.DealOrderByWithRelationInput {
    if (NULLABLE_SORT_FIELDS.has(sortBy)) {
      return { [sortBy]: { sort: sortOrder, nulls: 'last' } } as Prisma.DealOrderByWithRelationInput;
    }

    return { [sortBy]: sortOrder } as Prisma.DealOrderByWithRelationInput;
  }

  /**
   * Queues a win-probability run.
   *
   * Non-fatal by construction, exactly as with lead scoring: the deal is already
   * saved, and a missing prediction is a nuisance while a 500 on a successful
   * write is a bug.
   */
  private async enqueueScoring(dealId: string): Promise<void> {
    try {
      await this.scoringQueue.add(
        'score-deal',
        { dealId, tenantId: requireTenantId() },
        {
          // Hyphens, not colons — BullMQ reserves `:` as its Redis key separator
          // and rejects custom job ids containing one.
          jobId: `score-deal-${dealId}`,
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Could not queue win prediction for deal ${dealId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
