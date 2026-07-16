import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantPlan } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Max, Min } from 'class-validator';

export class CreateCheckoutDto {
  @ApiProperty({ enum: TenantPlan, example: TenantPlan.GROWTH })
  @IsEnum(TenantPlan)
  plan: TenantPlan;

  @ApiProperty({
    example: 5,
    minimum: 1,
    maximum: 500,
    description:
      'Seats to buy. Must be at least the number of people already in the workspace — ' +
      'buying fewer is a decision about who gets locked out, not a discount.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // A cap, because a typo in a seat field is a typo in an invoice. 500 is far
  // above the stated ceiling of the target market, and a customer who genuinely
  // needs more is an Enterprise conversation with a human.
  @Max(500)
  seats: number;
}

export class ChangeSeatsDto {
  @ApiProperty({ example: 8, minimum: 1, maximum: 500 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  seats: number;
}

export class PlanView {
  @ApiProperty() key: TenantPlan;
  @ApiProperty() name: string;
  @ApiProperty() tagline: string;
  @ApiProperty({ description: 'Per seat, per month, in paise. ₹499 is 49900.' })
  pricePerSeatMonthly: number;
  @ApiProperty({ isArray: true, type: String }) features: readonly string[];
  @ApiPropertyOptional() defaultSeats?: number;
}
