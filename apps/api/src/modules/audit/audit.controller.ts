import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/auth.decorators';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { PERMISSIONS } from 'src/modules/rbac/permissions';
import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'Lead', description: 'Filter by entity type.' })
  @IsString()
  @IsOptional()
  resource?: string;

  @ApiPropertyOptional({ description: 'Filter to one record — its full history.' })
  @IsUUID()
  @IsOptional()
  resourceId?: string;

  @ApiPropertyOptional({ description: 'Filter to one actor.' })
  @IsUUID()
  @IsOptional()
  userId?: string;
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOperation({
    summary: 'Read the audit trail',
    description:
      'Scoped to the caller\'s workspace. Sensitive fields are redacted at write ' +
      'time, so nothing here needs filtering on read.',
  })
  list(@Query() query: AuditQueryDto) {
    return this.auditService.list(query);
  }
}
