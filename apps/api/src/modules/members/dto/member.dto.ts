import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class InviteMemberDto {
  @ApiProperty({ example: 'arjun@acmetrading.in' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ description: 'The role the invitee will hold once they accept.' })
  @IsUUID()
  roleId: string;
}

export class ChangeRoleDto {
  @ApiProperty()
  @IsUUID()
  roleId: string;
}

/**
 * Accepting an invite as a *new* user.
 *
 * The email is deliberately absent — it comes from the invitation, never the
 * request body. Taking it from the body would let anyone holding one valid
 * invite token claim a seat under a different address than the one that was
 * invited, which quietly defeats the whole point of inviting a specific person.
 */
export class AcceptInviteDto {
  @ApiProperty({ example: 'Arjun' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Nair' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'a-strong-password', minLength: 8 })
  @IsString()
  // 8 is the floor, not a recommendation. The real defence is Argon2id plus
  // rate-limited login; a length rule mostly stops the worst accidents.
  @MinLength(8)
  @MaxLength(200)
  password: string;
}
