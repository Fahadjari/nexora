import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { CryptoService } from 'src/common/crypto/crypto.service';
import { runCrossTenant } from 'src/common/context/request-context';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import type { AppConfig } from 'src/config/configuration';
import type { AccessTokenPayload, RefreshTokenPayload, TokenPair } from './auth.types';

interface IssueOptions {
  userId: string;
  tenantId: string;
  email: string;
  isSuperAdmin: boolean;
  /** Continues an existing rotation lineage. Omit to start a new one at login. */
  familyId?: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Mints, rotates and revokes tokens.
 *
 * The design worth understanding is refresh-token rotation with reuse
 * detection:
 *
 *   • Every refresh consumes the presented token and issues a new one. A
 *     refresh token is therefore single-use.
 *   • Tokens issued from one another form a *family*, sharing a `familyId`.
 *   • Presenting an already-rotated token means two parties hold the same
 *     token — the legitimate client and a thief. We cannot tell which one is
 *     asking, so we revoke the entire family. Both are logged out; the real
 *     user signs in again, and the thief gets nothing.
 *
 * Without reuse detection, a stolen refresh token is a permanent, invisible
 * session. With it, the theft is self-limiting and leaves a trail.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Issues a fresh access/refresh pair and persists the refresh token's hash. */
  async issuePair(options: IssueOptions): Promise<TokenPair> {
    const familyId = options.familyId ?? randomUUID();
    const jti = randomUUID();

    const accessPayload: AccessTokenPayload = {
      sub: options.userId,
      tid: options.tenantId,
      email: options.email,
      ...(options.isSuperAdmin ? { sa: true } : {}),
    };

    const refreshPayload: RefreshTokenPayload = {
      sub: options.userId,
      tid: options.tenantId,
      fam: familyId,
      jti,
    };

    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    // Pass the TTL in seconds rather than as `15m`. jsonwebtoken's `expiresIn`
    // is typed `number | StringValue`, and a plain `string` does not satisfy
    // that union — handing it seconds is both type-correct and unambiguous.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: this.ttlToSeconds(accessTtl),
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: this.ttlToSeconds(refreshTtl),
      }),
    ]);

    await runCrossTenant(() =>
      this.prisma.refreshToken.create({
        data: {
          userId: options.userId,
          // Store only a fingerprint. A leaked backup then yields no usable
          // sessions, and SHA-256 is enough because the token is already
          // high-entropy — there is nothing to guess.
          tokenHash: this.crypto.hashToken(refreshToken),
          familyId,
          expiresAt: this.expiryFromNow(refreshTtl),
          userAgent: options.userAgent,
          ipAddress: options.ipAddress,
        },
      }),
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.ttlToSeconds(accessTtl),
    };
  }

  /**
   * Verifies a refresh token, retires it, and issues its successor.
   *
   * Throws — and burns the whole family — if the token has already been used.
   */
  async rotate(
    presentedToken: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<{ pair: TokenPair; userId: string; tenantId: string }> {
    let payload: RefreshTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(presentedToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const tokenHash = this.crypto.hashToken(presentedToken);

    const stored = await runCrossTenant(() =>
      this.prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: {
          user: {
            select: { id: true, email: true, isSuperAdmin: true, deletedAt: true },
          },
        },
      }),
    );

    // Signed correctly but not on file: the row was pruned, or the secret was
    // rotated. Either way it is not a live session.
    if (!stored) {
      throw new UnauthorizedException('Refresh token is no longer valid.');
    }

    // --- Reuse detection ---
    // This token was already exchanged. Two parties hold it; we cannot tell
    // which is legitimate, so we trust neither and kill the lineage.
    if (stored.rotatedAt || stored.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected for user ${payload.sub} (family ${payload.fam}). ` +
          `Revoking the family — this is either token theft or a badly behaved client.`,
      );
      await this.revokeFamily(payload.fam);
      throw new UnauthorizedException(
        'This session has been ended for security reasons. Please sign in again.',
      );
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token has expired.');
    }

    if (stored.user.deletedAt) {
      throw new UnauthorizedException('This account is no longer active.');
    }

    // Retire the presented token *before* issuing its replacement, so a crash
    // between the two leaves the user logged out rather than holding two live
    // tokens (fail closed).
    await runCrossTenant(() =>
      this.prisma.refreshToken.update({
        where: { tokenHash },
        data: { rotatedAt: new Date() },
      }),
    );

    const pair = await this.issuePair({
      userId: stored.user.id,
      tenantId: payload.tid,
      email: stored.user.email,
      isSuperAdmin: stored.user.isSuperAdmin,
      familyId: payload.fam, // stay in the same lineage
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    return { pair, userId: stored.user.id, tenantId: payload.tid };
  }

  /** Ends one session. Idempotent: logging out twice is not an error. */
  async revokeToken(refreshToken: string): Promise<void> {
    const tokenHash = this.crypto.hashToken(refreshToken);

    await runCrossTenant(() =>
      this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** Kills a rotation lineage — triggered by reuse detection. */
  async revokeFamily(familyId: string): Promise<void> {
    await runCrossTenant(() =>
      this.prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** Signs the user out everywhere. Used on password change and by "log out all
   *  devices" — after a password change, any session an attacker still holds
   *  must die, or the change achieved nothing. */
  async revokeAllForUser(userId: string): Promise<void> {
    await runCrossTenant(() =>
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** Deletes expired rows. Scheduled nightly; purely housekeeping. */
  async pruneExpired(): Promise<number> {
    const result = await runCrossTenant(() =>
      this.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      }),
    );
    return result.count;
  }

  /** Parses `15m` / `30d` / `3600` into seconds. */
  private ttlToSeconds(ttl: string): number {
    const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
    if (!match) {
      throw new Error(`Cannot parse TTL "${ttl}". Use forms like 15m, 24h, 30d.`);
    }

    const value = Number(match[1]);
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

    return value * (multipliers[match[2] ?? 's'] ?? 1);
  }

  private expiryFromNow(ttl: string): Date {
    return new Date(Date.now() + this.ttlToSeconds(ttl) * 1000);
  }
}
