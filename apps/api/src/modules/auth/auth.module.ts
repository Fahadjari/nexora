import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CryptoService } from 'src/common/crypto/crypto.service';
import { AuditModule } from 'src/modules/audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MembershipCache } from './membership-cache.service';
import { TokenService } from './token.service';

/**
 * Global because `JwtAuthGuard` is registered app-wide and needs `MembershipCache`
 * and `JwtService` injectable from anywhere. `CryptoService` is exported for the
 * same reason — other modules (invites, API keys) hash and encrypt too.
 */
@Global()
@Module({
  imports: [
    // Secrets are passed per-call rather than configured here: access and
    // refresh tokens are signed with *different* secrets, so a leaked access
    // secret cannot be used to forge a 30-day refresh token.
    JwtModule.register({}),
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, MembershipCache, CryptoService],
  exports: [AuthService, TokenService, MembershipCache, CryptoService, JwtModule],
})
export class AuthModule {}
