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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/auth.decorators';
import { PERMISSIONS } from 'src/modules/rbac/permissions';
import { ConvertLeadDto, CreateLeadDto, LeadQueryDto, UpdateLeadDto } from './dto/lead.dto';
import { LeadsService } from './leads.service';

/**
 * Lead endpoints.
 *
 * Authentication is global (JwtAuthGuard), so nothing here opts in to it —
 * routes are protected by default and a new endpoint is safe the day it is
 * written. Authorization is explicit per route: every handler declares the
 * permission it needs, and a handler with no `@RequirePermissions` would be
 * merely authenticated, which for business data is a review-blocking mistake.
 */
@ApiTags('CRM · Leads')
@ApiBearerAuth()
@Controller('crm/leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.LEAD_CREATE)
  @ApiOperation({
    summary: 'Create a lead',
    description:
      'Returns immediately. AI scoring runs in the background — poll the lead, ' +
      'or listen on the websocket, for `aiScore` to appear a moment later.',
  })
  @ApiResponse({ status: 201, description: 'Lead created.' })
  create(@Body() dto: CreateLeadDto) {
    return this.leadsService.create(dto);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  @ApiOperation({ summary: 'List leads', description: 'Paginated, filterable and searchable.' })
  findMany(@Query() query: LeadQueryDto) {
    return this.leadsService.findMany(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  @ApiOperation({ summary: 'Get one lead, with recent activities and notes' })
  @ApiResponse({ status: 404, description: 'No such lead in this workspace.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.leadsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Update a lead',
    description: 'Re-scores in the background if a field the model reasons about changed.',
  })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLeadDto) {
    return this.leadsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.LEAD_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a lead',
    description: 'Soft delete — the record is hidden, not destroyed, and stays in the audit trail.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.leadsService.remove(id);
  }

  @Post(':id/convert')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE, PERMISSIONS.CUSTOMER_CREATE)
  @ApiOperation({
    summary: 'Convert a lead to a customer',
    description:
      'Creates the customer and their primary contact, and optionally opens a deal — ' +
      'all in one transaction. Converting twice is rejected.',
  })
  convert(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConvertLeadDto) {
    return this.leadsService.convert(id, dto);
  }

  @Post(':id/rescore')
  @RequirePermissions(PERMISSIONS.AI_RUN_AGENT)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-score a lead now',
    description: 'Queues a fresh scoring run. Costs tokens, hence the separate permission.',
  })
  rescore(@Param('id', ParseUUIDPipe) id: string) {
    return this.leadsService.requestRescore(id);
  }
}
