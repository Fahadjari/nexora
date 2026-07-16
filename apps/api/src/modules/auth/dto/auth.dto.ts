import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Password policy: length is the only rule that reliably buys entropy.
 * Composition rules ("one uppercase, one symbol") push people toward
 * `Password1!` and are explicitly discouraged by NIST 800-63B, so we ask for
 * length and leave the rest alone.
 */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

export class RegisterDto {
  @ApiProperty({ example: 'priya@acmetrading.in' })
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(255)
  email: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, example: 'correct horse battery staple' })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  })
  @MaxLength(MAX_PASSWORD_LENGTH)
  password: string;

  @ApiProperty({ example: 'Priya' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Sharma' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'Acme Trading', description: 'Name of the workspace to create.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  companyName: string;

  @ApiPropertyOptional({
    example: 'acme-trading',
    description: 'Workspace URL slug. Derived from the company name when omitted.',
  })
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug may contain only lowercase letters, numbers and single hyphens.',
  })
  @Length(3, 60)
  slug?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'priya@acmetrading.in' })
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiPropertyOptional({
    description:
      'Workspace to sign in to. Omit when the user belongs to exactly one — ' +
      'the API picks it. Required when they belong to several.',
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class VerifyTwoFactorDto {
  @ApiProperty({ description: 'The challenge token returned by /auth/login.' })
  @IsString()
  @IsNotEmpty()
  challengeToken: string;

  @ApiProperty({ example: '123456', description: 'Six-digit TOTP code, or a recovery code.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code: string;
}

export class EnableTwoFactorDto {
  @ApiProperty({ example: '123456', description: 'Code from the authenticator app, to prove setup worked.' })
  @IsString()
  @Length(6, 6, { message: 'Enter the six-digit code from your authenticator app.' })
  code: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword: string;
}

export class SwitchTenantDto {
  @ApiProperty({ description: 'The workspace to switch into.' })
  @IsUUID()
  tenantId: string;
}
