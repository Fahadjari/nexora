import { Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * Team management: members, roles, and the invitation lifecycle.
 *
 * Depends on three global modules it does not import — Auth (CryptoService,
 * TokenService, MembershipCache), Billing (SubscriptionService, for the seat
 * limit), and Prisma. All are `@Global`, so the wiring is just the injection.
 */
@Module({
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
