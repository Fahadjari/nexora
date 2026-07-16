import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, MembershipStatus, Prisma, TenantStatus } from '@prisma/client';
import { authenticator } from 'otplib';
import { CryptoService } from 'src/common/crypto/crypto.service';
import { runCrossTenant, runInTenant } from 'src/common/context/request-context';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { SubscriptionService } from 'src/modules/billing/subscription.service';
import { SYSTEM_ROLES } from 'src/modules/rbac/permissions';
import type { AppConfig } from 'src/config/configuration';
import { MembershipCache } from './membership-cache.service';
import { TokenService } from './token.service';
import type { AuthResult, LoginResponse } from './auth.types';
import type {
  ChangePasswordDto,
  EnableTwoFactorDto,
  LoginDto,
  RegisterDto,
  VerifyTwoFactorDto,
} from './dto/auth.dto';

/** How long a half-finished (password-accepted, 2FA-pending) login stays open. */
const TWO_FACTOR_CHALLENGE_TTL = '5m';
const RECOVERY_CODE_COUNT = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly membershipCache: MembershipCache,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  // =========================================================================
  // Registration
  // =========================================================================

  /**
   * Creates a user, their workspace, the workspace's default roles, and the
   * owner membership binding them together.
   *
   * All five writes happen in one transaction. A half-created workspace — a
   * user with no tenant, or a tenant with no owner — is unrecoverable without
   * manual surgery, and this is the one moment where that can happen.
   */
  async register(
    dto: RegisterDto,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const email = this.normalizeEmail(dto.email);

    const existing = await runCrossTenant(() =>
      this.prisma.user.findUnique({ where: { email }, select: { id: true } }),
    );

    if (existing) {
      // An honest 409 here does confirm the address is registered. That is a
      // real tradeoff, but the alternative — pretending to succeed — leaves the
      // user staring at a screen that never signs them in. Signup is
      // rate-limited, which is the mitigation that actually matters.
      throw new ConflictException('An account with that email already exists.');
    }

    const slug = await this.deriveUniqueSlug(dto.slug ?? dto.companyName);
    const passwordHash = await this.crypto.hashPassword(dto.password);

    const { user, tenant, ownerRole } = await runCrossTenant(() =>
      this.prisma.$transaction(async (tx) => {
        const createdTenant = await tx.tenant.create({
          data: {
            name: dto.companyName,
            slug,
            status: TenantStatus.TRIAL,
          },
        });

        // Seed every default role, not just owner — the workspace should be
        // ready to invite a sales rep the minute it exists.
        await tx.role.createMany({
          data: SYSTEM_ROLES.map((role) => ({
            tenantId: createdTenant.id,
            key: role.key,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            isSystem: true,
          })),
        });

        const createdOwnerRole = await tx.role.findFirstOrThrow({
          where: { tenantId: createdTenant.id, key: 'owner' },
        });

        const createdUser = await tx.user.create({
          data: {
            email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            // Self-registration implies the address works only once we send a
            // verification mail. Left null on purpose; the verification flow
            // sets it.
          },
        });

        await tx.membership.create({
          data: {
            userId: createdUser.id,
            tenantId: createdTenant.id,
            roleId: createdOwnerRole.id,
            status: MembershipStatus.ACTIVE,
            acceptedAt: new Date(),
          },
        });

        // Start the 14-day trial in the *same* transaction as the tenant.
        // A workspace that exists without a subscription is one the billing
        // guard immediately locks with "no subscription found" — a broken first
        // five seconds, and the one impression a new customer never un-sees. So
        // the two are born together or not at all.
        await this.subscriptions.startTrial(tx, createdTenant.id);

        // A default pipeline, so the CRM is not an empty room on first login.
        const pipeline = await tx.pipeline.create({
          data: { tenantId: createdTenant.id, name: 'Sales Pipeline', isDefault: true },
        });

        await tx.pipelineStage.createMany({
          data: [
            { pipelineId: pipeline.id, name: 'Qualification', position: 1, probability: 10 },
            { pipelineId: pipeline.id, name: 'Needs Analysis', position: 2, probability: 25 },
            { pipelineId: pipeline.id, name: 'Proposal', position: 3, probability: 50 },
            { pipelineId: pipeline.id, name: 'Negotiation', position: 4, probability: 75 },
            { pipelineId: pipeline.id, name: 'Won', position: 5, probability: 100, isWon: true },
            { pipelineId: pipeline.id, name: 'Lost', position: 6, probability: 0, isLost: true },
          ],
        });

        return { user: createdUser, tenant: createdTenant, ownerRole: createdOwnerRole };
      }),
    );

    this.logger.log(`Workspace ${tenant.slug} created by ${user.email}`);

    await runInTenant(tenant.id, () =>
      this.audit.record({
        action: AuditAction.CREATE,
        resource: 'Tenant',
        resourceId: tenant.id,
        userId: user.id,
        metadata: { slug: tenant.slug },
      }),
    );

    const pair = await this.tokens.issuePair({
      userId: user.id,
      tenantId: tenant.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    return {
      ...pair,
      user: this.toPublicUser(user),
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      permissions: ownerRole.permissions,
    };
  }

  // =========================================================================
  // Login
  // =========================================================================

  async login(dto: LoginDto, context: { userAgent?: string; ipAddress?: string }): Promise<LoginResponse> {
    const email = this.normalizeEmail(dto.email);

    const user = await runCrossTenant(() =>
      this.prisma.user.findFirst({
        where: { email, deletedAt: null },
        include: {
          memberships: {
            where: { status: MembershipStatus.ACTIVE, deletedAt: null, tenant: { deletedAt: null } },
            include: {
              tenant: { select: { id: true, slug: true, name: true, status: true } },
              role: { select: { permissions: true } },
            },
          },
        },
      }),
    );

    // Verify a password even when the user does not exist. Skipping the Argon2
    // work for unknown addresses makes "no such user" measurably faster than
    // "wrong password", which turns login into a user-enumeration oracle.
    const passwordValid = user?.passwordHash
      ? await this.crypto.verifyPassword(user.passwordHash, dto.password)
      : await this.burnPasswordCycles(dto.password);

    if (!user || !passwordValid) {
      await this.audit.recordAnonymous({
        action: AuditAction.LOGIN_FAILED,
        resource: 'User',
        metadata: { email, reason: 'invalid_credentials' },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      throw new UnauthorizedException('Incorrect email or password.');
    }

    if (user.memberships.length === 0) {
      throw new UnauthorizedException(
        'Your account is not a member of any active workspace. Ask an owner to re-invite you.',
      );
    }

    const membership = this.selectMembership(user.memberships, dto.tenantId);

    if (membership.tenant.status === TenantStatus.SUSPENDED) {
      throw new UnauthorizedException('This workspace is suspended. Contact support.');
    }

    // Password was right, but it is only the first factor.
    if (user.twoFactorEnabled) {
      return {
        twoFactorRequired: true,
        challengeToken: await this.issueChallengeToken(user.id, membership.tenant.id),
      };
    }

    return this.completeLogin(user.id, membership.tenant.id, context);
  }

  /**
   * Second leg of a 2FA login: exchanges the challenge token plus a code for
   * real tokens.
   */
  async verifyTwoFactor(
    dto: VerifyTwoFactorDto,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    let claims: { sub: string; tid: string; typ: string };

    try {
      claims = await this.jwtService.verifyAsync(dto.challengeToken, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Your sign-in attempt expired. Please start again.');
    }

    // A challenge token is not an access token. Without this check, an access
    // token would satisfy the 2FA step — and anything holding one has already
    // passed 2FA, so it would be circular, but it would also mean a token
    // minted for one purpose is accepted for another. Type them.
    if (claims.typ !== '2fa_challenge') {
      throw new UnauthorizedException('Invalid challenge token.');
    }

    const user = await runCrossTenant(() =>
      this.prisma.user.findUnique({ where: { id: claims.sub } }),
    );

    if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
      throw new UnauthorizedException('Two-factor authentication is not enabled on this account.');
    }

    const accepted =
      this.verifyTotpCode(user.twoFactorSecret, dto.code) ||
      (await this.consumeRecoveryCode(user.id, user.twoFactorRecoveryCodes, dto.code));

    if (!accepted) {
      await this.audit.recordAnonymous({
        action: AuditAction.LOGIN_FAILED,
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'invalid_2fa_code' },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      throw new UnauthorizedException('That code is not valid.');
    }

    return this.completeLogin(user.id, claims.tid, context);
  }

  /** Shared tail of every successful login. */
  private async completeLogin(
    userId: string,
    tenantId: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const membership = await runCrossTenant(() =>
      this.prisma.membership.findFirstOrThrow({
        where: { userId, tenantId, status: MembershipStatus.ACTIVE },
        include: {
          user: true,
          tenant: { select: { id: true, slug: true, name: true } },
          role: { select: { permissions: true } },
        },
      }),
    );

    await runCrossTenant(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      }),
    );

    const pair = await this.tokens.issuePair({
      userId,
      tenantId,
      email: membership.user.email,
      isSuperAdmin: membership.user.isSuperAdmin,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    await runInTenant(tenantId, () =>
      this.audit.record({
        action: AuditAction.LOGIN,
        resource: 'User',
        resourceId: userId,
        userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      }),
    );

    return {
      ...pair,
      user: this.toPublicUser(membership.user),
      tenant: membership.tenant,
      permissions: membership.role.permissions,
    };
  }

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  async refresh(
    refreshToken: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const { pair, userId, tenantId } = await this.tokens.rotate(refreshToken, context);

    const membership = await runCrossTenant(() =>
      this.prisma.membership.findFirst({
        where: { userId, tenantId, status: MembershipStatus.ACTIVE, deletedAt: null },
        include: {
          user: true,
          tenant: { select: { id: true, slug: true, name: true } },
          role: { select: { permissions: true } },
        },
      }),
    );

    // The refresh token was valid, but the seat is gone — removed while the
    // session was live. Refuse, and kill the family so the client stops trying.
    if (!membership) {
      await this.tokens.revokeAllForUser(userId);
      throw new UnauthorizedException('Your access to this workspace has been removed.');
    }

    return {
      ...pair,
      user: this.toPublicUser(membership.user),
      tenant: membership.tenant,
      permissions: membership.role.permissions,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeToken(refreshToken);
  }

  /**
   * Moves a user into another of their workspaces.
   *
   * Mints a *new* token pair rather than swapping a claim, because the tenant
   * lives inside the signed token. That is the whole point: a token cannot be
   * re-aimed at a workspace the user does not belong to.
   */
  async switchTenant(
    userId: string,
    targetTenantId: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const membership = await runCrossTenant(() =>
      this.prisma.membership.findFirst({
        where: {
          userId,
          tenantId: targetTenantId,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    );

    if (!membership) {
      throw new NotFoundException('You are not a member of that workspace.');
    }

    return this.completeLogin(userId, targetTenantId, context);
  }

  // =========================================================================
  // Two-factor setup
  // =========================================================================

  /**
   * Step one of enrolment: generate a secret and hand back a QR-code URI.
   *
   * The secret is stored immediately but `twoFactorEnabled` stays false until
   * the user proves they can generate a code. Flipping the flag first would let
   * a mistyped setup lock someone out of their own workspace permanently.
   */
  async beginTwoFactorSetup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await runCrossTenant(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    );

    if (user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled.');
    }

    const secret = authenticator.generateSecret();

    await runCrossTenant(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorSecret: this.crypto.encrypt(secret) },
      }),
    );

    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, 'Nexora', secret),
    };
  }

  /** Step two: verify a code, switch 2FA on, and return the recovery codes. */
  async confirmTwoFactorSetup(
    userId: string,
    dto: EnableTwoFactorDto,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await runCrossTenant(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    );

    if (!user.twoFactorSecret) {
      throw new BadRequestException('Start two-factor setup before confirming it.');
    }

    if (!this.verifyTotpCode(user.twoFactorSecret, dto.code)) {
      throw new BadRequestException('That code is not valid. Check your authenticator app.');
    }

    // Show these once, store them hashed. If the database leaks, the codes in
    // it must not be usable — they are, after all, a bypass for the second
    // factor.
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      this.crypto.randomToken(8),
    );

    await runCrossTenant(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: true,
          twoFactorRecoveryCodes: recoveryCodes.map((code) => this.crypto.hashToken(code)),
        },
      }),
    );

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'User',
      resourceId: userId,
      userId,
      metadata: { twoFactorEnabled: true },
    });

    return { recoveryCodes };
  }

  async disableTwoFactor(userId: string, password: string): Promise<void> {
    const user = await runCrossTenant(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    );

    // Re-authenticate. Turning off a security control from a session someone
    // walked away from is exactly the scenario 2FA exists to prevent.
    if (!user.passwordHash || !(await this.crypto.verifyPassword(user.passwordHash, password))) {
      throw new UnauthorizedException('Incorrect password.');
    }

    await runCrossTenant(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorRecoveryCodes: [],
        },
      }),
    );

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'User',
      resourceId: userId,
      userId,
      metadata: { twoFactorEnabled: false },
    });
  }

  // =========================================================================
  // Password
  // =========================================================================

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await runCrossTenant(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    );

    if (
      !user.passwordHash ||
      !(await this.crypto.verifyPassword(user.passwordHash, dto.currentPassword))
    ) {
      throw new UnauthorizedException('Your current password is incorrect.');
    }

    // Hash outside the callback: `runCrossTenant` takes a synchronous factory,
    // so awaiting inside it is not allowed (and would also do the expensive
    // Argon2 work while holding the cross-tenant scope open for no reason).
    const passwordHash = await this.crypto.hashPassword(dto.newPassword);

    await runCrossTenant(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
    );

    // Every other session dies. If the password was changed *because* it was
    // compromised, leaving the attacker's session alive would defeat the point.
    await this.tokens.revokeAllForUser(userId);

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'User',
      resourceId: userId,
      userId,
      metadata: { passwordChanged: true },
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Picks which workspace a login lands in.
   *
   * Requesting a workspace the user has no seat in is a 401, not a redirect to
   * a different one — silently signing someone into the wrong company would be
   * a confusing and dangerous surprise.
   */
  private selectMembership<T extends { tenant: { id: string } }>(
    memberships: T[],
    requestedTenantId?: string,
  ): T {
    if (!requestedTenantId) {
      return memberships[0];
    }

    const match = memberships.find((m) => m.tenant.id === requestedTenantId);

    if (!match) {
      throw new UnauthorizedException('You are not a member of that workspace.');
    }

    return match;
  }

  private async issueChallengeToken(userId: string, tenantId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, tid: tenantId, typ: '2fa_challenge' },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: TWO_FACTOR_CHALLENGE_TTL,
      },
    );
  }

  /**
   * Verifies a TOTP code against the encrypted secret.
   *
   * `window: 1` accepts the neighbouring 30-second steps, which absorbs clock
   * drift between the phone and the server. Wider windows start meaningfully
   * enlarging the guessing surface, so one step is the usual compromise.
   */
  private verifyTotpCode(encryptedSecret: string, code: string): boolean {
    try {
      const secret = this.crypto.decrypt(encryptedSecret);
      authenticator.options = { window: 1 };
      return authenticator.verify({ token: code.trim(), secret });
    } catch {
      return false;
    }
  }

  /** Checks a recovery code and burns it — each is good exactly once. */
  private async consumeRecoveryCode(
    userId: string,
    storedHashes: string[],
    presented: string,
  ): Promise<boolean> {
    const presentedHash = this.crypto.hashToken(presented.trim());
    const match = storedHashes.find((hash) => this.crypto.safeEqual(hash, presentedHash));

    if (!match) return false;

    await runCrossTenant(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorRecoveryCodes: storedHashes.filter((hash) => hash !== match) },
      }),
    );

    this.logger.warn(`User ${userId} signed in with a recovery code.`);
    return true;
  }

  /**
   * Spends roughly the same time as a real Argon2 verification, for accounts
   * that do not exist. See the comment at the call site in `login()`.
   */
  private async burnPasswordCycles(candidate: string): Promise<false> {
    const decoy = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$JmSRnbcVLJcnKZlKQVKr9F7Z9lJ8mDDzYQ0dtF6cLXA';
    await this.crypto.verifyPassword(decoy, candidate);
    return false;
  }

  /** Lowercases and trims. Emails are case-insensitive in practice, and storing
   *  both `Priya@` and `priya@` as distinct accounts is a support nightmare. */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Turns a company name into a free workspace slug, appending -2, -3 on clash. */
  private async deriveUniqueSlug(source: string): Promise<string> {
    const base =
      source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'workspace';

    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;

      const taken = await runCrossTenant(() =>
        this.prisma.tenant.findUnique({ where: { slug: candidate }, select: { id: true } }),
      );

      if (!taken) return candidate;
    }

    // 100 collisions on one name means something is wrong, or someone is
    // squatting. Fall back to a random suffix rather than looping forever.
    return `${base}-${this.crypto.randomToken(4).toLowerCase()}`;
  }

  private toPublicUser(user: Prisma.UserGetPayload<object>): AuthResult['user'] {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      isSuperAdmin: user.isSuperAdmin,
    };
  }
}
