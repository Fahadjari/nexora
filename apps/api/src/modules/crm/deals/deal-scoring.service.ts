import { Injectable, Logger } from '@nestjs/common';
import type { Deal, PipelineStage } from '@prisma/client';
import { AiService } from 'src/modules/ai/ai.service';
import type { JsonSchema } from 'src/modules/ai/ai.types';

const DEAL_WIN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    winProbability: {
      type: 'integer',
      description: 'Likelihood this deal closes won, 0 (dead) to 100 (as good as signed).',
    },
    insight: {
      type: 'string',
      description:
        'One or two sentences naming the specific risk or advantage that drives the number, ' +
        'and what the rep should do about it.',
    },
  },
  required: ['winProbability', 'insight'],
};

export interface DealWinPrediction {
  winProbability: number;
  insight: string;
}

/** The stage context the model needs. Its own probability is the base rate. */
export type ScorableDeal = Deal & { stage: PipelineStage };

@Injectable()
export class DealScoringService {
  private readonly logger = new Logger(DealScoringService.name);

  constructor(private readonly ai: AiService) {}

  /**
   * Predicts whether a deal will close.
   *
   * Returns null when AI is unavailable — same contract as lead scoring. A deal
   * without a prediction is a deal without a prediction, not a failed operation.
   */
  async predict(deal: ScorableDeal): Promise<DealWinPrediction | null> {
    const response = await this.ai.tryComplete<DealWinPrediction>({
      system:
        'You forecast B2B sales deals. You are given the stage the deal sits in and that ' +
        "stage's historical win rate — treat that rate as the base rate and adjust from it, " +
        'rather than inventing a number from scratch. Adjust *down* for staleness, a close ' +
        'date already in the past, or a deal with no named customer; adjust *up* only for ' +
        'concrete evidence of momentum. A deal that has sat in the same stage for months is ' +
        'not a 50/50 no matter how large it is. Say plainly what is wrong with the deal — a ' +
        'rep needs to know what to fix, not to be reassured.',
      messages: [{ role: 'user', content: this.describe(deal) }],
      jsonSchema: DEAL_WIN_SCHEMA,
      maxTokens: 512,
    });

    if (!response) return null;

    const result = response.content;

    // Constrained decoding fixes the type, not the range. Clamp: a probability
    // outside 0–100 would poison every forecast and sort that reads the column.
    const winProbability = Math.max(0, Math.min(100, Math.round(result.winProbability)));

    if (winProbability !== result.winProbability) {
      this.logger.warn(
        `Model returned an out-of-range win probability (${result.winProbability}); ` +
          `clamped to ${winProbability}.`,
      );
    }

    return { ...result, winProbability };
  }

  /**
   * Renders the deal for the model.
   *
   * The stage's historical win rate is included on purpose: without an anchor,
   * models reach for round, confident numbers. Given a base rate, they adjust
   * from it — which is both more accurate and more explainable to the rep who
   * has to act on it.
   */
  private describe(deal: ScorableDeal): string {
    const daysInStage = this.daysSince(deal.updatedAt);
    const closeDate = deal.expectedCloseDate;

    const lines = [
      `Deal: ${deal.title}`,
      `Value: ${deal.value.toString()} ${deal.currency}`,
      `Current stage: ${deal.stage.name}`,
      `Historical win rate at this stage: ${deal.stage.probability}%`,
      `Days since the deal last changed: ${daysInStage}`,
      `Age: ${this.daysSince(deal.createdAt)} days since the deal was opened`,
      `Expected close date: ${
        closeDate
          ? `${closeDate.toISOString().slice(0, 10)}${
              // An overdue close date is the single strongest negative signal in
              // a pipeline, and the one reps are most likely to leave stale.
              // Stating it as a fact beats hoping the model does the date maths.
              closeDate.getTime() < Date.now() ? ' (OVERDUE — this date has already passed)' : ''
            }`
          : 'not set'
      }`,
      `Customer on record: ${deal.customerId ? 'yes' : 'no — the deal is not linked to a customer'}`,
    ];

    return `Forecast this sales deal.\n\n${lines.join('\n')}`;
  }

  private daysSince(date: Date): number {
    return Math.floor((Date.now() - date.getTime()) / 86_400_000);
  }
}
