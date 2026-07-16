import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, Public } from 'src/common/decorators/auth.decorators';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  EnableTwoFactorDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  SwitchTenantDto,
  VerifyTwoFactorDto,
} from './dto/auth.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Pulls the client fingerprint we attach to sessions and audit rows. */
  private clientContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    };
  }

  @Public()
  // Signup is a spam and enumeration target, so it is throttled harder than the
  // global default: five workspaces an hour from one IP is already generous.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create a user and their workspace' })
  @ApiResponse({ status: 201, description: 'Workspace created; tokens returned.' })
  @ApiResponse({ status: 409, description: 'Email already registered.' })
  register(@Body() dto: RegisterDto, @Req() request: Request) {
    return this.authService.register(dto, this.clientContext(request));
  }

  @Public()
  // Ten attempts per minute per IP. Enough for a fumbled password, nowhere near
  // enough to make credential stuffing worthwhile.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns tokens, or — when the account has 2FA enabled — a challenge token ' +
      'to be exchanged at /auth/2fa/verify.',
  })
  @ApiResponse({ status: 200, description: 'Signed in, or 2FA challenge issued.' })
  @ApiResponse({ status: 401, description: 'Incorrect credentials.' })
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.authService.login(dto, this.clientContext(request));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a 2FA sign-in' })
  verifyTwoFactor(@Body() dto: VerifyTwoFactorDto, @Req() request: Request) {
    return this.authService.verifyTwoFactor(dto, this.clientContext(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Refresh tokens are single-use. Presenting one twice is treated as theft ' +
      'and ends every session in that lineage.',
  })
  refresh(@Body() dto: RefreshDto, @Req() request: Request) {
    return this.authService.refresh(dto.refreshToken, this.clientContext(request));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Move to another workspace you belong to' })
  switchTenant(
    @CurrentUser('userId') userId: string,
    @Body() dto: SwitchTenantDto,
    @Req() request: Request,
  ) {
    return this.authService.switchTenant(userId, dto.tenantId, this.clientContext(request));
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user, workspace and permissions' })
  me(@CurrentUser() user: ReturnType<typeof Object>) {
    return user;
  }

  // --- Two-factor management ---

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Begin 2FA enrolment',
    description: 'Returns a secret and an otpauth:// URI to render as a QR code.',
  })
  beginTwoFactorSetup(@CurrentUser('userId') userId: string) {
    return this.authService.beginTwoFactorSetup(userId);
  }

  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Confirm 2FA enrolment',
    description: 'Returns recovery codes. They are shown once and stored hashed.',
  })
  confirmTwoFactorSetup(@CurrentUser('userId') userId: string, @Body() dto: EnableTwoFactorDto) {
    return this.authService.confirmTwoFactorSetup(userId, dto);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Turn 2FA off. Requires the account password.' })
  async disableTwoFactor(
    @CurrentUser('userId') userId: string,
    @Body() body: { password: string },
  ): Promise<void> {
    await this.authService.disableTwoFactor(userId, body.password);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password',
    description: 'Signs the user out of every other session on success.',
  })
  async changePassword(
    @CurrentUser('userId') userId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.authService.changePassword(userId, dto);
  }
}
