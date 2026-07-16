import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pipeline, PipelineStage } from '@prisma/client';
import { TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';

export type PipelineWithStages = Pipeline & { stages: PipelineStage[] };

/**
 * Read access to the tenant's sales processes.
 *
 * Deliberately read-only for now. Editing a pipeline is not a CRUD screen — it
 * is a migration: deleting a stage has to answer "where do the 40 deals sitting
 * in it go?", and reordering changes what every forecast means. Shipping a naive
 * `DELETE /stages/:id` that orphans deals would be worse than shipping nothing,
 * so the seeded six-stage default stands until stage management gets designed
 * properly. `PIPELINE_MANAGE` exists in the catalogue and is currently held only
 * by Owner/Admin, ready for it.
 */
@Injectable()
export class PipelinesService {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}

  async findMany(): Promise<PipelineWithStages[]> {
    return this.db.pipeline.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  }

  async findOne(id: string): Promise<PipelineWithStages> {
    const pipeline = await this.db.pipeline.findFirst({
      where: { id },
      include: { stages: { orderBy: { position: 'asc' } } },
    });

    if (!pipeline) {
      throw new NotFoundException('Pipeline not found.');
    }

    return pipeline;
  }
}
