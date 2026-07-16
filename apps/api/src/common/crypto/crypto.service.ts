import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import * as argon2 from 'argon2';
import type { AppConfig } from 'src/config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the size GCM is specified for
const AUTH_TAG_LENGTH = 16;

/**
 * Hashing and symmetric encryption.
 *
 * Two different jobs, deliberately not conflated:
 *
 *   • Passwords are *hashed* with Argon2id — slow and salted, so a stolen
 *     database is not a stolen password list. There is no way back.
 *   • TOTP secrets are *encrypted* with AES-256-GCM, because the server must be
 *     able to read them back to verify a code. Storing them in plaintext would
 *     mean a database leak hands the attacker the second factor too, which
 *     rather defeats the point of having one.
 *   • Refresh tokens get a plain SHA-256. They are already 256 bits of entropy,
 *     so there is nothing to brute-force and no reason to pay Argon2's cost on
 *     every token refresh.
 */
@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;

  constructor(config: ConfigService<AppConfig, true>) {
    // Derive the data-encryption key from the refresh secret rather than adding
    // another env var. scrypt with a fixed salt is fine here: the input is
    // already high-entropy (32+ random chars, enforced by the env schema), so
    // the salt is not defending against a dictionary attack.
    const secret = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.encryptionKey = scryptSync(secret, 'nexora-data-encryption', 32);
  }

  // --- Passwords -----------------------------------------------------------

  /**
   * Argon2id with parameters at the OWASP-recommended floor: 19 MiB of memory,
   * two passes. Memory-hardness is what makes GPU cracking uneconomic — an
   * attacker can parallelise compute far more cheaply than memory.
   */
  async hashPassword(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verifyPassword(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed hash in the database is a data problem, not a valid login.
      return false;
    }
  }

  // --- Symmetric encryption -----------------------------------------------

  /**
   * Encrypts to `iv:authTag:ciphertext`, all base64.
   *
   * GCM rather than CBC: it authenticates as well as encrypts, so a tampered
   * ciphertext fails to decrypt instead of quietly producing garbage that some
   * downstream code then trusts.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
      ':',
    );
  }

  decrypt(encrypted: string): string {
    const [ivB64, authTagB64, ciphertextB64] = encrypted.split(':');

    if (!ivB64 || !authTagB64 || !ciphertextB64) {
      throw new Error('Malformed ciphertext.');
    }

    const authTag = Buffer.from(authTagB64, 'base64');
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Malformed ciphertext: bad auth tag.');
    }

    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  // --- Tokens --------------------------------------------------------------

  /** Fingerprints a refresh token for storage. Never store the token itself. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** URL-safe random string, for invite tokens and 2FA recovery codes. */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /**
   * Constant-time string comparison.
   *
   * `a === b` short-circuits on the first differing byte, which leaks the length
   * of the matching prefix through timing. That is enough to reconstruct a
   * secret one byte at a time, given enough attempts.
   */
  safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);

    // timingSafeEqual throws on length mismatch, so compare lengths first — but
    // note this does leak length, which for our use (fixed-length digests and
    // codes) is not a secret.
    if (bufferA.length !== bufferB.length) return false;

    return timingSafeEqual(bufferA, bufferB);
  }
}
