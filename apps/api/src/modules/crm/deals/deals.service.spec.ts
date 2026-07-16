import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runInTenant } from 'src/common/context/request-context';
import { DealsService } from './deals.service';

/**
 * `move()` is the only write in the CRM with real business rules attached, and
 * every one of them exists because getting it wrong corrupts data that finance
 * later reads as fact:
 *
 *   • A deal moved into another pipeline's stage vanishes from both boards.
 *   • A won deal with no `closedAt` never appears in the quarter it closed in.
 *   • A re-opened deal that keeps its `closedAt` is counted as revenue *and* as
 *     open pipeline — the same money, twice.
 *   • A loss with no reason is the one data point the loss model needs, gone.
 *
 * So the rules get tests. The database is mocked: these assert the decisions,
 * not Prisma's ability to write a row, and they run in milliseconds on every
 * commit.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PIPELINE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_PIPELINE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const STAGE_PROPOSAL = { id: 'stage-proposal', pipelineId: PIPELINE, name: 'Proposal', position: 3, probability: 50, isWon: false, isLost: false };
const STAGE_WON = { id: 'stage-won', pipelineId: PIPELINE, name: 'Won', position: 5, probability: 100, isWon: true, isLost: false };
const STAGE_LOST = { id: 'stage-lost', pipelineId: PIPELINE, name: 'Lost', position: 6, probability: 0, isWon: false, isLost: true };

/** Stages of a *different* pipeline. Reachable by id, and must be refused. */
const FOREIGN_STAGE = { id: 'stage-foreign', pipelineId: OTHER_PIPELINE, name: 'Their Stage', position: 1, probability: 10, isWon: false, isLost: false };

const ALL_STAGES = [STAGE_PROPOSAL, STAGE_WON, STAGE_LOST, FOREIGN_STAGE];

function buildDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deal-1',
    tenantId: TENANT,
    title: '400 tonnes TMT bars',
    value: new Prisma.Decimal(850000),
    currency: 'INR',
    pipelineId: PIPELINE,
    stageId: STAGE_PROPOSAL.id,
    stage: STAGE_PROPOSAL,
    customerId: null,
    ownerId: null,
    closedAt: null,
    lostReason: null,
    expectedCloseDate: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/**
 * A stand-in for the tenant-scoped Prisma client.
 *
 * `pipelineStage.findFirst` honours the `pipelineId` in the where clause,
 * because that constraint is precisely what the cross-pipeline test is testing.
 * A mock that ignored it would make the test pass no matter what the service did.
 */
function buildMocks(deal: Record<string, unknown>) {
  const update = jest.fn().mockImplementation(({ data }) => ({ ...deal, ...data }));

  const db = {
    deal: {
      findFirst: jest.fn().mockResolvedValue(deal),
      update,
    },
    pipelineStage: {
      findFirst: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          ALL_STAGES.find(
            (stage) =>
              stage.id === where.id &&
              (where.pipelineId === undefined || stage.pipelineId === where.pipelineId),
          ) ?? null,
        ),
      ),
    },
  };

  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined), diff: jest.fn().mockReturnValue({}) };

  const service = new DealsService(db as never, queue as never, audit as never);

  return { service, db, queue, audit, update };
}

describe('DealsService.move', () => {
  it('refuses a stage belonging to another pipeline', async () => {
    const { service, update } = buildMocks(buildDeal());

    await runInTenant(TENANT, async () => {
      await expect(service.move('deal-1', { stageId: FOREIGN_STAGE.id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    // The important half of the assertion: it refused *without writing*.
    expect(update).not.toHaveBeenCalled();
  });

  it('stamps closedAt when the deal is won', async () => {
    const { service, update } = buildMocks(buildDeal());

    await runInTenant(TENANT, async () => {
      await service.move('deal-1', { stageId: STAGE_WON.id });
    });

    const { data } = update.mock.calls[0][0];

    expect(data.stageId).toBe(STAGE_WON.id);
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data.lostReason).toBeNull();
  });

  it('requires a reason before a deal can be marked lost', async () => {
    const { service, update } = buildMocks(buildDeal());

    await runInTenant(TENANT, async () => {
      await expect(service.move('deal-1', { stageId: STAGE_LOST.id })).rejects.toThrow(
        /why the deal was lost/i,
      );
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('records the loss reason when one is given', async () => {
    const { service, update } = buildMocks(buildDeal());

    await runInTenant(TENANT, async () => {
      await service.move('deal-1', {
        stageId: STAGE_LOST.id,
        lostReason: 'Undercut on price by 12%.',
      });
    });

    const { data } = update.mock.calls[0][0];

    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data.lostReason).toBe('Undercut on price by 12%.');
  });

  it('re-opening a closed deal clears closedAt and the loss reason', async () => {
    // A deal that was lost last week and has just been revived. If `closedAt`
    // survives the move, the deal is simultaneously closed and open — counted
    // once as a result and once as pipeline.
    const lostDeal = buildDeal({
      stageId: STAGE_LOST.id,
      stage: STAGE_LOST,
      closedAt: new Date('2026-02-01'),
      lostReason: 'Undercut on price by 12%.',
    });

    const { service, update } = buildMocks(lostDeal);

    await runInTenant(TENANT, async () => {
      await service.move('deal-1', { stageId: STAGE_PROPOSAL.id });
    });

    const { data } = update.mock.calls[0][0];

    expect(data.stageId).toBe(STAGE_PROPOSAL.id);
    expect(data.closedAt).toBeNull();
    expect(data.lostReason).toBeNull();
  });

  it('treats a move to the current stage as a no-op', async () => {
    // A card dragged and dropped back where it came from. Writing here would
    // bump updatedAt — which the AI reads as "days since the deal last changed",
    // so a fidgeting rep would quietly refresh the staleness of their own deals.
    const { service, update, audit, queue } = buildMocks(buildDeal());

    await runInTenant(TENANT, async () => {
      await service.move('deal-1', { stageId: STAGE_PROPOSAL.id });
    });

    expect(update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not spend tokens re-forecasting a deal that just closed', async () => {
    const { service, queue } = buildMocks(buildDeal());

    await runInTenant(TENANT, async () => {
      await service.move('deal-1', { stageId: STAGE_WON.id });
    });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('re-forecasts a deal that moved between open stages', async () => {
    const deal = buildDeal({ stageId: STAGE_WON.id, stage: STAGE_WON, closedAt: new Date() });
    const { service, queue } = buildMocks(deal);

    await runInTenant(TENANT, async () => {
      await service.move('deal-1', { stageId: STAGE_PROPOSAL.id });
    });

    expect(queue.add).toHaveBeenCalledTimes(1);

    // The job must carry the tenant: the worker has no request context to
    // inherit and re-establishes the scope from the payload.
    expect(queue.add.mock.calls[0][1]).toEqual({ dealId: 'deal-1', tenantId: TENANT });
  });
});
