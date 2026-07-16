import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public, RequirePermissions } from 'src/common/decorators/auth.decorators';
import { BillingExempt } from 'src/modules/billing/billing.decorators';
import { PERMISSIONS } from 'src/modules/rbac/permissions';
import { AcceptInviteDto, ChangeRoleDto, InviteMemberDto } from './dto/member.dto';
import { MembersService } from './members.service';

/**
 * Team management.
 *
 * Split intent across two audiences:
 *
 *   • The **member-facing** routes (list, invite, remove) require a session and
 *     the relevant `member:*` permission.
 *   • The **invite acceptance** routes are `@Public()` — the invitee is a
 *     stranger holding a token, with no account and no session yet. They are
 *     also `@BillingExempt()`: a workspace whose trial lapsed must still be able
 *     to add the teammate who is going to pay the bill.
 */
@ApiTags('Team')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MEMBER_READ)
  @ApiOperation({ summary: 'List the people in this workspace' })
  list() {
    return this.members.listMembers();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.MEMBER_READ)
  @ApiOperation({ summary: 'Roles available to assign — for the invite dropdown' })
  roles() {
    return this.members.listRoles();
  }

  @Get('invitations')
  @RequirePermissions(PERMISSIONS.MEMBER_READ)
  @ApiOperation({ summary: 'Outstanding invitations' })
  invitations() {
    return this.members.listInvitations();
  }

  @Post('invitations')
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  @ApiOperation({
    summary: 'Invite someone',
    description:
      'Refused with 403 if every seat on the current plan is used — pending invitations ' +
      'count as used seats. Returns a link to share (email delivery is not wired up yet).',
  })
  @ApiResponse({ status: 403, description: 'No seats left on the plan.' })
  @ApiResponse({ status: 409, description: 'Already a member.' })
  invite(@Body() dto: InviteMemberDto) {
    return this.members.invite(dto.email, dto.roleId);
  }

  @Delete('invitations/:id')
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.revokeInvitation(id);
  }

  @Patch(':membershipId/role')
  @RequirePermissions(PERMISSIONS.MEMBER_UPDATE)
  @ApiOperation({
    summary: "Change a member's role",
    description: 'Takes effect on their next request — permissions are resolved per request.',
  })
  changeRole(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.members.changeRole(membershipId, dto.roleId);
  }

  @Delete(':membershipId')
  @RequirePermissions(PERMISSIONS.MEMBER_REMOVE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member',
    description: 'Frees their seat. Soft delete — their history stays intact.',
  })
  remove(@Param('membershipId', ParseUUIDPipe) membershipId: string) {
    return this.members.removeMember(membershipId);
  }

  // --- Invite acceptance: public, billing-exempt ---

  @Get('invitations/token/:token')
  @Public()
  @BillingExempt()
  @ApiOperation({
    summary: 'Preview an invitation',
    description: 'What the accept page shows before someone joins. Public — no session needed.',
  })
  @ApiResponse({ status: 404, description: 'Invalid or expired invitation.' })
  preview(@Param('token') token: string) {
    return this.members.previewInvitation(token);
  }

  @Post('invitations/token/:token/accept')
  @Public()
  @BillingExempt()
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Creates the account if the email is new (and logs them straight in), or attaches the ' +
      'seat to an existing account (which then signs in normally).',
  })
  accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.members.accept(token, dto);
  }
}
