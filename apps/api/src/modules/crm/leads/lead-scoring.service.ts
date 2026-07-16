import { Injectable, Logger } from '@nestjs/common';
import { Lead } from '@prisma/client';
import { AiService } from 'src/modules/ai/ai.service';
import type { JsonSchema } from 'src/modules/ai/ai.types';

/**
 * The shape we force the model to return. Constrained decoding means the
 * response cannot come back malformed — no defensive parsing, no "sometimes it
 * wraps the JSON in a markdown fence" nonsense.
 */
const LEAD_SCORE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    score: {
      type: 'integer',
      description: 'Likelihood this lead converts, 0 (hopeless) to 100 (near-certain).',
    },
    reason: {
      type: 'string',
      description:
        'One or two sentences a salesperson can act on, citing the specific ' +
        'signals that drove the score.',
    },
    suggestedNextAction: {
      type: 'string',
      description: 'The single next step most likely to move this lead forward.',
    },
  },
  required: ['score', 'reason', 'suggestedNextAction'],
};

export interface LeadScore {
  score: number;
  reason: string;
  suggestedNextAction: string;
}

@Injectable()
export class LeadScoringService {
  private readonly logger = new Logger(LeadScoringService.name);

  constructor(private readonly ai: AiService) {}

  /**
   * Scores a lead.
   *
   * Returns null rather than throwing when AI is unavailable or the model
   * declines. That is the whole contract: a lead that cannot be scored is a
   * lead without a score, not a failed operation. The caller carries on.
   */
  async score(lead: Lead): Promise<LeadScore | null> {
    const response = await this.ai.tryComplete<LeadScore>({
      system:
        'You score sales leads for a B2B company. Judge only on the evidence given. ' +
        'A lead with no contact details, no company, and no stated budget is weak no ' +
        'matter how promising the name sounds — say so plainly rather than being ' +
        'encouraging. Reserve scores above 80 for leads with a named company, a ' +
        'reachable contact, and a concrete budget. Be specific about which signals ' +
        'drove your score; a salesperson has to act on it.',
      messages: [{ role: 'user', content: this.describe(lead) }],
      jsonSchema: LEAD_SCORE_SCHEMA,
      maxTokens: 512,
    });

    if (!response) return null;

    const result = response.content;

    // The schema constrains the *type* to integer, but nothing stops a model
    // from returning 150. Clamp rather than trust — a score outside 0–100 would
    // corrupt every sort, filter and average that reads this column.
    const score = Math.max(0, Math.min(100, Math.round(result.score)));

    if (score !== result.score) {
      this.logger.warn(`Model returned an out-of-range score (${result.score}); clamped to ${score}.`);
    }

    return { ...result, score };
  }

  /**
   * Renders a lead as prose for the model.
   *
   * Missing fields are stated as missing rather than omitted. "No email on
   * record" is a genuine negative signal; silently leaving the line out lets
   * the model assume the data simply wasn't shown to it, and it scores the lead
   * as though the gap didn't exist.
   */
  private describe(lead: Lead): string {
    const lines = [
      `Name: ${lead.firstName} ${lead.lastName}`,
      `Company: ${lead.companyName ?? 'not provided'}`,
      `Job title: ${lead.jobTitle ?? 'not provided'}`,
      `Email: ${lead.email ?? 'not provided'}`,
      `Phone: ${lead.phone ?? 'not provided'}`,
      `Source: ${lead.source}`,
      `Current status: ${lead.status}`,
      `Estimated value: ${lead.estimatedValue ? lead.estimatedValue.toString() : 'not provided'}`,
      `Age: ${this.daysOld(lead.createdAt)} days since the lead was created`,
    ];

    return `Score this sales lead.\n\n${lines.join('\n')}`;
  }

  private daysOld(createdAt: Date): number {
    return Math.floor((Date.now() - createdAt.getTime()) / 86_400_000);
  }
}
