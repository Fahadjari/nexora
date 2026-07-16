/** Claims carried by the short-lived access token. */
export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  /** Tenant id — an access token is always scoped to one workspace. Switching
   *  workspaces means minting a new token, not mutating a header, so a stolen
   *  token cannot be re-pointed at a different company. */
  tid: string;
  email: string;
  /** Super admin. Abbreviated to keep the token small. */
  sa?: boolean;
  iat?: number;
  exp?: number;
}

/** Claims carried by the refresh token. */
export interface RefreshTokenPayload {
  sub: string;
  tid: string;
  /** Rotation family. Lets us revoke a whole lineage when we see replay. */
  fam: string;
  /** Unique per token, so the stored hash differs even for identical claims. */
  jti: string;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds — lets the client refresh proactively. */
  expiresIn: number;
}

/** What a login attempt returns once every factor has been satisfied. */
export interface AuthResult extends TokenPair {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    isSuperAdmin: boolean;
  };
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
  permissions: string[];
}

/**
 * Returned when credentials are correct but 2FA is still outstanding. The
 * client exchanges `challengeToken` plus a TOTP code for real tokens.
 */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeToken: string;
}

export type LoginResponse = AuthResult | TwoFactorChallenge;

export function isTwoFactorChallenge(response: LoginResponse): response is TwoFactorChallenge {
  return 'twoFactorRequired' in response;
}
