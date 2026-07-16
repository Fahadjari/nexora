import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, type Customer } from '@prisma/client';
import { getContext } from 'src/common/context/request-context';
import { PaginatedResponse, resolveSort } from 'src/common/dto/pagination.dto';
import { AuditService } from 'src/modules/audit/audit.service';
import { TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import type { CreateCustomerDto, CustomerQueryDto, UpdateCustomerDto } from './dto/customer.dto';

const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'name', 'aiRiskScore'] as const;

/**
 * Prisma only accepts `orderBy: { field: { sort, nulls } }` on nullable columns
 * and throws on required ones — so the `nulls` hint has to be applied
 * selectively. Only the AI-written risk score is nullable here.
 */
const NULLABLE_SORT_FIELDS = new Set<string>(['aiRiskScore']);

@Injectable()
export class CustomersService {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateCustomerDto): Promise<Customer> {
    const context = getContext();

    const customer = await this.db.customer.create({
      data: {
        ...dto,
        ownerId: dto.ownerId ?? context?.userId ?? null,
      } as Prisma.CustomerUncheckedCreateInput,
    });

    await this.audit.record({
      action: AuditAction.CREATE,
      resource: 'Customer',
      resourceId: customer.id,
      metadata: { name: customer.name },
    });

    return customer;
  }

  async findMany(query: CustomerQueryDto): Promise<PaginatedResponse<Customer>> {
    const where: Prisma.CustomerWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.minRiskScore !== undefined ? { aiRiskScore: { gte: query.minRiskScore } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { phone: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { taxId: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const sortBy = resolveSort(query.sortBy, SORTABLE_FIELDS, 'createdAt');

    const [data, total] = await Promise.all([
      this.db.customer.findMany({
        where,
        orderBy: NULLABLE_SORT_FIELDS.has(sortBy)
          ? ({ [sortBy]: { sort: query.sortOrder, nulls: 'last' } } as Prisma.CustomerOrderByWithRelationInput)
          : ({ [sortBy]: query.sortOrder } as Prisma.CustomerOrderByWithRelationInput),
        skip: query.skip,
        take: query.limit,
        include: {
          owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          // Cheap signal for the list view — how much is open with this account.
          _count: { select: { deals: true, contacts: true } },
        },
      }),
      this.db.customer.count({ where }),
    ]);

    return new PaginatedResponse(data, total, query);
  }

  async findOne(id: string): Promise<Customer> {
    const customer = await this.db.customer.findFirst({
      where: { id },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        contacts: { where: { deletedAt: null }, orderBy: { isPrimary: 'desc' } },
        deals: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { stage: { select: { id: true, name: true, isWon: true, isLost: true } } },
        },
        activities: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found.');
    }

    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    const before = await this.findOne(id);

    const customer = await this.db.customer.update({
      where: { id },
      data: dto as Prisma.CustomerUncheckedUpdateInput,
    });

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Customer',
      resourceId: id,
      changes: this.audit.diff(
        before as unknown as Record<string, unknown>,
        dto as Record<string, unknown>,
      ),
    });

    return customer;
  }

  /**
   * Soft delete.
   *
   * Deliberately does NOT cascade to deals and invoices. A customer with
   * revenue history who is "deleted" must still appear in last quarter's books —
   * hiding them from the customer list is a UI concern; erasing them from the
   * accounts is a compliance problem.
   */
  async remove(id: string): Promise<void> {
    await this.findOne(id);

    await this.db.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({ action: AuditAction.DELETE, resource: 'Customer', resourceId: id });
  }
}
