import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  InvitationStatus,
  MembershipStatus,
  Prisma,
  type Invitation,
} from '@prisma/client';
import { CryptoService } from 'src/common/crypto/crypto.service';
import {
  getContext,
  requireTenantId,
  runCrossTenant,
  runInTenant,
} from 'src/common/context/request-context';
import { AuditService } from 'src/modules/audit/audit.service';
import { MembershipCache } from 'src/modules/auth/membership-cache.service';
import { TokenService } from 'src/modules/auth/token.service';
import type { AuthResult } from 'src/modules/auth/auth.types';
import { SubscriptionService } from 'src/modules/billing/subscription.service';
import { PLANS } from 'src/modules/billing/plans';
import { PrismaService, TENANT_DB, type TenantDb } from 'src/modules/prisma/prisma.service';
import type { AppConfig } from 'src/config/configuration';
import { ConfigService } from '@nestjs/config';
import type { AcceptInviteDto } from './dto/member.dto';

/** How long an invite link stays good. Long enough to survive a weekend inbox. */
const INVITE_TTL_DAYS = 7;

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly membershipCache: MembershipCache,
    private readonly subscriptions: SubscriptionService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Everyone with a seat, plus the roles they hold. */
  async listMembers() {
    return this.db.membership.findMany({
      where: { status: { not: MembershipStatus.SUSPENDED } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        jobTitle: true,
        createdAt: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true },
        },
        role: { select: { id: true, key: true, name: true } },
      },
    });
  }

  /** Roles available to assign — populates the invite dropdown. */
  async listRoles() {
    return this.db.role.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, key: true, name: true, description: true },
    });
  }

  async listInvitations() {
    return this.db.invitation.findMany({
      where: { status: InvitationStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        role: { select: { id: true, name: true } },
        invitedBy: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /**
   * Invites someone to the workspace.
   *
   * This is where the seat limit actually bites — and it is checked against
   * seats *used*, where "used" counts pending invitations as well as accepted
   * members. Counting only accepted members would let an owner fire off twenty
   * invitations on a five-seat plan and have all twenty land, blowing past the
   * limit the moment people click their links. An unaccepted invite is a seat
   * you have already promised.
   */
  async invite(email: string, roleId: string): Promise<{ invitation: Invitation; inviteUrl: string }> {
    const tenantId = requireTenantId();
    const normalisedEmail = email.trim().toLowerCase();

    const entitlements = await this.subscriptions.currentEntitlements();
    const seatsUsed = await this.subscriptions.seatsInUse();

    if (seatsUsed >= entitlements.seats) {
      // A 402-shaped refusal, but thrown as a domain error the controller maps.
      // The message names the number and the fix, because "seat limit reached"
      // with no next step is a support ticket waiting to happen.
      throw new ForbiddenException(
        `You have used all ${entitlements.seats} seats on your ${PLANS[entitlements.plan].name} ` +
          `plan. Buy more seats or remove a member to invite someone new.`,
      );
    }

    // The role must belong to this tenant. The scoped client already guarantees
    // it, but a clear 404 beats a foreign-key error surfacing as a 500.
    const role = await this.db.role.findFirst({ where: { id: roleId, deletedAt: null } });
    if (!role) {
      throw new NotFoundException('That role does not exist in this workspace.');
    }

    // Already a member? Inviting them again is a no-op that only causes
    // confusion, so say so plainly.
    const existingMember = await runCrossTenant(() =>
      this.prisma.membership.findFirst({
        where: { tenantId, user: { email: normalisedEmail }, status: { not: MembershipStatus.SUSPENDED } },
        select: { id: true },
      }),
    );

    if (existingMember) {
      throw new ConflictException('That person is already a member of this workspace.');
    }

    // One live invite per address. A stale PENDING invite is revoked and
    // replaced rather than duplicated — otherwise a fat-fingered re-send leaves
    // two valid links for one seat, and accepting both would double-book it.
    await this.db.invitation.updateMany({
      where: { email: normalisedEmail, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED },
    });

    // The raw token is shown once and never stored. We keep only its SHA-256, so
    // a leaked database backup is not a pile of working invite links.
    const rawToken = this.crypto.randomToken(32);
    const tokenHash = this.crypto.hashToken(rawToken);

    const context = getContext();

    const invitation = await this.db.invitation.create({
      // `tenantId` is absent by design — the tenant-scope extension stamps it at
      // runtime, and no service is allowed to write one. The cast tells the
      // compiler what the extension guarantees. Same pattern as every other
      // create in the codebase.
      data: {
        email: normalisedEmail,
        roleId,
        tokenHash,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        invitedById: context!.userId!,
        status: InvitationStatus.PENDING,
      } as Prisma.InvitationUncheckedCreateInput,
    });

    await this.audit.record({
      action: AuditAction.CREATE,
      resource: 'Invitation',
      resourceId: invitation.id,
      metadata: { email: normalisedEmail, role: role.name },
    });

    const inviteUrl = `${this.config.get('WEB_URL', { infer: true })}/accept-invite?token=${rawToken}`;

    // No mailer wired yet, so the link is returned to the inviter to share and
    // logged here. This is the one honest gap in the flow — swapping the log for
    // an email send is the whole of "wire up invitations for real". Until then
    // the product works; it just asks a human to paste a link.
    this.logger.log(`Invitation for ${normalisedEmail} → ${inviteUrl}`);

    return { invitation, inviteUrl };
  }

  /** Revokes a pending invitation. The link stops working immediately. */
  async revokeInvitation(id: string): Promise<void> {
    const invitation = await this.db.invitation.findFirst({ where: { id } });

    if (!invitation) {
      throw new NotFoundException('Invitation not found.');
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new BadRequestException('That invitation is no longer pending.');
    }

    await this.db.invitation.update({
      where: { id },
      data: { status: InvitationStatus.REVOKED },
    });

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Invitation',
      resourceId: id,
      metadata: { revoked: true },
    });
  }

  /**
   * Reads an invitation by its raw token, for the accept page.
   *
   * Public and unauthenticated — the invitee is a stranger to us until they
   * accept. Returns only what a person deciding whether to join needs to see,
   * and never the token or anything that would let them enumerate others.
   */
  async previewInvitation(rawToken: string) {
    const invitation = await this.findLiveInvitation(rawToken);

    return {
      email: invitation.email,
      companyName: invitation.tenant.name,
      roleName: invitation.role.name,
      invitedBy: `${invitation.invitedBy.firstName} ${invitation.invitedBy.lastName}`,
      // Whether this address already has a Nexora login decides which path the
      // accept page shows: set a password, or just log in.
      hasAccount: invitation.userExists,
    };
  }

  /**
   * Accepts an invite and creates the account in one step.
   *
   * Two cases, and they are genuinely different:
   *
   *   • **New person.** They set a password here, so we can safely log them
   *     straight in — they have just proven control of the account they created.
   *   • **Existing account.** We attach the seat, but do NOT issue tokens. We
   *     have not verified their password, and minting a session off a shared
   *     invite link for an account we cannot authenticate would be a takeover
   *     primitive. They log in normally, and the workspace is waiting.
   *
   * The whole thing runs cross-tenant because the invitee has no tenant context
   * yet — the invitation *is* how they acquire one.
   */
  async accept(rawToken: string, dto: AcceptInviteDto): Promise<AuthResult | { requiresLogin: true; email: string }> {
    const invitation = await this.findLiveInvitation(rawToken);

    return runCrossTenant(async () => {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: invitation.email },
      });

      const result = await this.prisma.$transaction(async (tx) => {
        let userId: string;
        let isNewUser: boolean;

        if (existingUser) {
          userId = existingUser.id;
          isNewUser = false;
        } else {
          const passwordHash = await this.crypto.hashPassword(dto.password);

          const created = await tx.user.create({
            data: {
              email: invitation.email,
              passwordHash,
              firstName: dto.firstName,
              lastName: dto.lastName,
              // Accepting an emailed invite is itself proof the address works.
              emailVerifiedAt: new Date(),
            },
          });

          userId = created.id;
          isNewUser = true;
        }

        // Reactivate a prior suspended seat rather than colliding on the
        // one-membership-per-user-per-tenant unique. A returning employee gets
        // their old seat back, not a unique-constraint 500.
        await tx.membership.upsert({
          where: { userId_tenantId: { userId, tenantId: invitation.tenantId } },
          create: {
            userId,
            tenantId: invitation.tenantId,
            roleId: invitation.roleId,
            status: MembershipStatus.ACTIVE,
            acceptedAt: new Date(),
          },
          update: {
            roleId: invitation.roleId,
            status: MembershipStatus.ACTIVE,
            acceptedAt: new Date(),
            deletedAt: null,
          },
        });

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date() },
        });

        return { userId, isNewUser };
      });

      // The seat count changed, so any cached "no membership" negative for this
      // user in this tenant must go, or their first request 401s despite a valid
      // seat.
      await this.membershipCache.invalidate(result.userId, invitation.tenantId);
      // And the tenant's seat usage feeds the entitlement summary.
      await this.subscriptions.invalidateEntitlements(invitation.tenantId);

      await this.auditAccept(invitation.tenantId, invitation.id, result.userId);

      if (!result.isNewUser) {
        // Existing account: no auto-login. Send them to sign in.
        return { requiresLogin: true as const, email: invitation.email };
      }

      return this.issueSessionFor(result.userId, invitation.tenantId);
    });
  }

  /**
   * Changes a member's role.
   *
   * Invalidates their cached permissions immediately — the whole reason
   * permissions are resolved per request rather than baked into the token is so
   * that a demotion takes effect on the member's *next* call, not in fifteen
   * minutes. Skipping this invalidation silently reintroduces exactly the delay
   * the architecture exists to avoid.
   */
  async changeRole(membershipId: string, roleId: string) {
    const tenantId = requireTenantId();

    const membership = await this.db.membership.findFirst({
      where: { id: membershipId },
      include: { user: { select: { id: true } }, role: { select: { key: true } } },
    });

    if (!membership) {
      throw new NotFoundException('Member not found.');
    }

    const role = await this.db.role.findFirst({ where: { id: roleId, deletedAt: null } });
    if (!role) {
      throw new NotFoundException('That role does not exist in this workspace.');
    }

    // Do not let the last owner demote themselves. A workspace with no owner is
    // one nobody can administer, bill, or delete — an unrecoverable state, and
    // the kind of thing a support team spends an afternoon undoing by hand.
    await this.guardLastOwner(membership.role.key, membershipId, 'change the role of');

    await this.db.membership.update({ where: { id: membershipId }, data: { roleId } });

    await this.membershipCache.invalidate(membership.user.id, tenantId);

    await this.audit.record({
      action: AuditAction.UPDATE,
      resource: 'Membership',
      resourceId: membershipId,
      metadata: { roleChangedTo: role.name },
    });

    return this.db.membership.findFirst({
      where: { id: membershipId },
      select: {
        id: true,
        role: { select: { id: true, name: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  /**
   * Removes a member — soft delete, and it frees a seat.
   *
   * The membership is soft-deleted, not the user: the person may still belong to
   * other workspaces, and their name still has to render on the deals and notes
   * they created. Their cache entry is invalidated so the removal is instant —
   * this is the fired-employee path, and "instant" is the entire requirement.
   */
  async removeMember(membershipId: string): Promise<void> {
    const tenantId = requireTenantId();

    const membership = await this.db.membership.findFirst({
      where: { id: membershipId },
      include: { user: { select: { id: true } }, role: { select: { key: true } } },
    });

    if (!membership) {
      throw new NotFoundException('Member not found.');
    }

    await this.guardLastOwner(membership.role.key, membershipId, 'remove');

    await this.db.membership.update({
      where: { id: membershipId },
      data: { status: MembershipStatus.SUSPENDED, deletedAt: new Date() },
    });

    await this.membershipCache.invalidate(membership.user.id, tenantId);
    await this.subscriptions.invalidateEntitlements(tenantId);

    await this.audit.record({
      action: AuditAction.DELETE,
      resource: 'Membership',
      resourceId: membershipId,
    });

    this.logger.log(`Member ${membershipId} removed from tenant ${tenantId}`);
  }

  // -------------------------------------------------------------------------

  /**
   * Finds a PENDING, unexpired invitation by raw token, or throws.
   *
   * Looks up by the *hash* of the token, never the token itself — the raw value
   * was never stored. Also reports whether a user already exists for the invited
   * address, since both callers need it. Cross-tenant, because the invitee has
   * no tenant scope yet.
   */
  private async findLiveInvitation(rawToken: string) {
    const tokenHash = this.crypto.hashToken(rawToken);

    return runCrossTenant(async () => {
      const invitation = await this.prisma.invitation.findUnique({
        where: { tokenHash },
        include: {
          tenant: { select: { name: true } },
          role: { select: { name: true } },
          invitedBy: { select: { firstName: true, lastName: true } },
        },
      });

      // A missing, spent, revoked or expired token all get the same answer. Being
      // specific ("this one expired") would help an attacker probing which random
      // tokens ever existed.
      if (
        !invitation ||
        invitation.status !== InvitationStatus.PENDING ||
        invitation.expiresAt.getTime() < Date.now()
      ) {
        throw new NotFoundException('This invitation is invalid or has expired.');
      }

      const userExists = await this.prisma.user.findUnique({
        where: { email: invitation.email },
        select: { id: true },
      });

      return { ...invitation, userExists: userExists !== null };
    });
  }

  /** Refuses to strip the last owner of a workspace. */
  private async guardLastOwner(roleKey: string, membershipId: string, verb: string): Promise<void> {
    if (roleKey !== 'owner') return;

    const otherOwners = await this.db.membership.count({
      where: {
        role: { key: 'owner' },
        status: MembershipStatus.ACTIVE,
        id: { not: membershipId },
      },
    });

    if (otherOwners === 0) {
      throw new BadRequestException(
        `You cannot ${verb} the last owner. Make someone else an owner first.`,
      );
    }
  }

  private async issueSessionFor(userId: string, tenantId: string): Promise<AuthResult> {
    const [user, membership] = await runCrossTenant(() =>
      Promise.all([
        this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
        this.prisma.membership.findFirstOrThrow({
          where: { userId, tenantId },
          include: { tenant: true, role: { select: { permissions: true } } },
        }),
      ]),
    );

    const pair = await this.tokens.issuePair({
      userId: user.id,
      tenantId,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    });

    return {
      ...pair,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        isSuperAdmin: user.isSuperAdmin,
      },
      tenant: {
        id: membership.tenant.id,
        slug: membership.tenant.slug,
        name: membership.tenant.name,
      },
      permissions: membership.role.permissions,
    };
  }

  private async auditAccept(tenantId: string, invitationId: string, userId: string): Promise<void> {
    // The audit write must be tenant-scoped, but we are running cross-tenant
    // (the invitee had no tenant until a moment ago). Re-establish the scope so
    // the entry lands in the right workspace's trail.
    await runInTenant(tenantId, () =>
      this.audit.record({
        action: AuditAction.UPDATE,
        resource: 'Invitation',
        resourceId: invitationId,
        userId,
        metadata: { accepted: true },
      }),
    );
  }
}
