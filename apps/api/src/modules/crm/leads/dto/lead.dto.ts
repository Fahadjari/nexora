import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { LeadSource, LeadStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
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

export class CreateLeadDto {
  @ApiProperty({ example: 'Rahul' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Mehta' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiPropertyOptional({ example: 'rahul@brightsteel.in' })
  @IsEmail()
  @IsOptional()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '+91 98765 43210' })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ example: 'Bright Steel Traders' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  companyName?: string;

  @ApiPropertyOptional({ example: 'Procurement Head' })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  jobTitle?: string;

  @ApiPropertyOptional({ enum: LeadStatus, default: LeadStatus.NEW })
  @IsEnum(LeadStatus)
  @IsOptional()
  status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadSource, default: LeadSource.OTHER })
  @IsEnum(LeadSource)
  @IsOptional()
  source?: LeadSource;

  @ApiPropertyOptional({ example: 250000, description: 'Expected deal size, in the tenant currency.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  // A cap that is absurd for an SMB but not for a typo. Catches the extra zero
  // before it skews every forecast on the dashboard.
  @Max(1_000_000_000)
  @IsOptional()
  estimatedValue?: number;

  @ApiPropertyOptional({ description: 'Owning sales rep. Defaults to the creator.' })
  @IsUUID()
  @IsOptional()
  ownerId?: string;
}

/**
 * Every field optional. Note `aiScore` is absent by design: it is written only
 * by the scoring worker. Letting a user PATCH their own score would make the
 * number meaningless and quietly poison the model's own future inputs.
 */
export class UpdateLeadDto extends PartialType(CreateLeadDto) {}

export class LeadQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LeadStatus })
  @IsEnum(LeadStatus)
  @IsOptional()
  status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadSource })
  @IsEnum(LeadSource)
  @IsOptional()
  source?: LeadSource;

  @ApiPropertyOptional({ description: 'Filter to one rep. Omit for the whole team.' })
  @IsUUID()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Only leads scoring at or above this.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  minScore?: number;
}

export class ConvertLeadDto {
  @ApiPropertyOptional({
    description: 'Name for the new customer. Defaults to the lead\'s company, then their full name.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  customerName?: string;

  @ApiPropertyOptional({ description: 'Open a deal for this lead at the same time.' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  dealTitle?: string;

  @ApiPropertyOptional({ description: 'Deal value. Defaults to the lead\'s estimated value.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  dealValue?: number;
}
