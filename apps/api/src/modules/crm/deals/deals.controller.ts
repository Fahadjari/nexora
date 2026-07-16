import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/auth.decorators';
import { PERMISSIONS } from 'src/modules/rbac/permissions';
import { DealsService } from './deals.service';
import { CreateDealDto, DealQueryDto, MoveDealDto, UpdateDealDto } from './dto/deal.dto';
import { PipelinesService } from './pipelines.service';

/**
 * Deal and pipeline endpoints.
 *
 * Auth is global; authorization is declared per route. Note that `/board` sits
 * *before* `/:id` — Nest matches routes in declaration order, and with the
 * reverse order "board" would be parsed as a deal id and rejected by
 * ParseUUIDPipe as malformed. A silly bug, and an easy one.
 */
@ApiTags('CRM · Deals')
@ApiBearerAuth()
@Controller('crm/deals')
export class DealsController {
  constructor(
    private readonly dealsService: DealsService,
    private readonly pipelinesService: PipelinesService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.DEAL_CREATE)
  @ApiOperation({
    summary: 'Open a deal',
    description:
      'Pipeline and stage are optional — a deal with neither lands in the first stage of ' +
      'the default pipeline, which is what "new deal" almost always means. AI predicts the ' +
      'win probability in the background.',
  })
  @ApiResponse({ status: 201, description: 'Deal created.' })
  @ApiResponse({ status: 400, description: 'No default pipeline, or the stage is not in it.' })
  create(@Body() dto: CreateDealDto) {
    return this.dealsService.create(dto);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.DEAL_READ)
  @ApiOperation({ summary: 'List deals', description: 'Paginated, filterable and searchable.' })
  findMany(@Query() query: DealQueryDto) {
    return this.dealsService.findMany(query);
  }

  @Get('board')
  @RequirePermissions(PERMISSIONS.DEAL_READ)
  @ApiQuery({
    name: 'pipelineId',
    required: false,
    description: 'Defaults to the workspace default pipeline.',
  })
  @ApiOperation({
    summary: 'The Kanban board',
    description:
      'Every stage of a pipeline with its deals. Each column is capped at 50 cards, but the ' +
      'count and value on the column header are the true totals — plus a win-rate-weighted ' +
      'forecast of the open pipeline.',
  })
  board(@Query('pipelineId') pipelineId?: string) {
    return this.dealsService.board(pipelineId);
  }

  @Get('pipelines')
  @RequirePermissions(PERMISSIONS.PIPELINE_READ)
  @ApiOperation({ summary: 'List the pipelines and their stages' })
  pipelines() {
    return this.pipelinesService.findMany();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.DEAL_READ)
  @ApiOperation({ summary: 'Get one deal, with its activities and notes' })
  @ApiResponse({ status: 404, description: 'No such deal in this workspace.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.dealsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.DEAL_UPDATE)
  @ApiOperation({
    summary: 'Update a deal',
    description:
      'Cannot change the stage — moving a deal has consequences (closing it, demanding a ' +
      'loss reason) and gets its own endpoint rather than being one field of a PATCH.',
  })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDealDto) {
    return this.dealsService.update(id, dto);
  }

  @Post(':id/move')
  @RequirePermissions(PERMISSIONS.DEAL_UPDATE)
  @ApiOperation({
    summary: 'Move a deal to another stage',
    description:
      'The drag-and-drop on the board. Moving into a won or lost stage closes the deal; ' +
      'a loss requires a reason. Moving a closed deal back into an open stage re-opens it.',
  })
  @ApiResponse({ status: 400, description: 'Stage is not in this pipeline, or a loss has no reason.' })
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveDealDto) {
    return this.dealsService.move(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.DEAL_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a deal',
    description: 'Soft delete — hidden, not destroyed, and it stays in the audit trail.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.dealsService.remove(id);
  }

  @Post(':id/rescore')
  @RequirePermissions(PERMISSIONS.AI_RUN_AGENT)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-run the win prediction now',
    description: 'Costs tokens, hence the separate permission.',
  })
  rescore(@Param('id', ParseUUIDPipe) id: string) {
    return this.dealsService.requestRescore(id);
  }
}
