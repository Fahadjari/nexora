import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Offset pagination for list endpoints.
 *
 * Offset, not cursor: SMB list views are small, sorted every which way, and
 * users expect to jump to page 7. Deep offsets are slow, which is why `limit`
 * is capped — the pathological `?page=50000` costs a bounded scan, not a table
 * walk. Feeds that grow without bound (the activity timeline) use a cursor
 * instead; see ActivitiesService.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'One-based page number.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({
    default: 25,
    minimum: 1,
    maximum: 100,
    description: 'Rows per page. Capped at 100 to bound query cost.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 25;

  @ApiPropertyOptional({ description: 'Free-text search. Fields searched vary by resource.' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: 'Field to sort by. Must be allow-listed by the resource.' })
  @IsString()
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortOrder: 'asc' | 'desc' = 'desc';

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

/** Envelope returned by every list endpoint. */
export class PaginatedResponse<T> {
  @ApiProperty({ isArray: true })
  data: T[];

  @ApiProperty({
    example: { page: 1, limit: 25, total: 137, totalPages: 6, hasNext: true, hasPrevious: false },
  })
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };

  constructor(data: T[], total: number, query: PaginationQueryDto) {
    const totalPages = Math.ceil(total / query.limit);

    this.data = data;
    this.meta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNext: query.page < totalPages,
      hasPrevious: query.page > 1,
    };
  }
}

/**
 * Guards `sortBy` against an allow-list.
 *
 * `orderBy` interpolates a column name into SQL. Prisma parameterises values,
 * not identifiers, so a user-supplied sort field must be checked against known
 * columns rather than trusted. Anything unrecognised falls back to the default.
 */
export function resolveSort<T extends string>(
  requested: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(requested as T) ? (requested as T) : fallback;
}
