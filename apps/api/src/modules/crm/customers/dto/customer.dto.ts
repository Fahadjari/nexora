import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CustomerStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Bright Steel Traders' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ example: 'accounts@brightsteel.in' })
  @IsEmail()
  @IsOptional()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ example: 'https://brightsteel.in' })
  @IsUrl()
  @IsOptional()
  website?: string;

  @ApiPropertyOptional({ example: '27AAPFU0939F1ZV', description: 'GSTIN / VAT number.' })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  taxId?: string;

  @ApiPropertyOptional({ example: 'Manufacturing' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  industry?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  billingAddress?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  shippingAddress?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: CustomerStatus, default: CustomerStatus.ACTIVE })
  @IsEnum(CustomerStatus)
  @IsOptional()
  status?: CustomerStatus;

  @ApiPropertyOptional({ default: 30, description: 'Payment terms in days. Ages receivables.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  paymentTermDays?: number;

  @ApiPropertyOptional({ description: 'Credit limit in the tenant currency.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  creditLimit?: number;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  ownerId?: string;
}

/** AI risk fields are absent by design — the Customer Success agent owns them. */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CustomerStatus })
  @IsEnum(CustomerStatus)
  @IsOptional()
  status?: CustomerStatus;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Only customers at or above this churn risk.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  minRiskScore?: number;
}
