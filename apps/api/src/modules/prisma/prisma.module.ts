import { Global, Module } from '@nestjs/common';
import { PrismaService, TENANT_DB, withTenantScope } from './prisma.service';

/**
 * Global so feature modules can inject the database without re-importing this
 * everywhere. Exports both clients, but note the asymmetry in intent:
 *
 *   TENANT_DB     — what you want. Tenant-scoped, soft-delete aware.
 *   PrismaService — raw and unscoped. Justify each use.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: TENANT_DB,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => withTenantScope(prisma),
    },
  ],
  exports: [PrismaService, TENANT_DB],
})
export class PrismaModule {}
