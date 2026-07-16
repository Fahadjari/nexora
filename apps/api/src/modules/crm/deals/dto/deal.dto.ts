import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class CreateDealDto {
  @ApiProperty({ example: '400 tonnes TMT bars — Q3' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 850000, description: 'Deal value in the deal currency.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  value: number;

  @ApiPropertyOptional({ example: 'INR', default: 'INR' })
  @IsString()
  @IsOptional()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({
    description:
      'Which pipeline to open the deal in. Defaults to the tenant\'s default pipeline.',
  })
  @IsUUID()
  @IsOptional()
  pipelineId?: string;

  @ApiPropertyOptional({
    description: 'Starting stage. Defaults to the first stage of the chosen pipeline.',
  })
  @IsUUID()
  @IsOptional()
  stageId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Defaults to the creating user.' })
  @IsUUID()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: 'ISO date the deal is expected to close.' })
  @IsDateString()
  @IsOptional()
  expectedCloseDate?: string;
}

/**
 * `stageId` is deliberately not updatable here.
 *
 * Moving a deal between stages has consequences — it stamps `closedAt`, demands
 * a reason on a loss, and is the single most interesting event in a deal's life
 * for forecasting. That belongs in an explicit `POST /:id/move` with its own
 * audit record, not smuggled in as one field of a generic PATCH where it would
 * silently bypass all of it.
 */
export class UpdateDealDto extends PartialType(
  OmitType(CreateDealDto, ['stageId', 'pipelineId'] as const),
) {}

export class MoveDealDto {
  @ApiProperty({ description: 'The stage to move the deal into. Must belong to the deal\'s pipeline.' })
  @IsUUID()
  stageId: string;

  @ApiPropertyOptional({
    example: 'Lost on price — competitor undercut us by 12%.',
    description: 'Required when moving into a lost stage. Nothing else is a valid answer to "why?".',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  lostReason?: string;
}

export class DealQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  pipelineId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  stageId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({
    description:
      'Only deals that are still in play — i.e. not in a won or lost stage. ' +
      'This is what a rep means by "my deals".',
  })
  @Type(() => Boolean)
  @IsOptional()
  openOnly?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Only deals at or above this AI win probability.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  minWinProbability?: number;
}
