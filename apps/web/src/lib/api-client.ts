import { useAuthStore } from './auth-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** The error shape the API's exception filter always returns. */
export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, string[]>;
  requestId: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Field-level messages, ready to hand to react-hook-form. */
  get fieldErrors(): Record<string, string> {
    if (!this.details) return {};

    return Object.fromEntries(
      Object.entries(this.details).map(([field, messages]) => [field, messages[0]]),
    );
  }
}

/**
 * Single-flight refresh.
 *
 * The problem this solves is easy to miss until it bites: a dashboard fires six
 * requests at once, the access token has just expired, and all six come back
 * 401. Refresh naively and you fire six refresh calls with the *same* refresh
 * token — but the backend rotates tokens and treats reuse as theft, so it
 * revokes the whole family and logs the user out. The security feature turns
 * into a bug.
 *
 * So: the first 401 starts a refresh and everyone else awaits the same promise.
 * Exactly one refresh call goes out, no matter how many requests were in flight.
 */
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  // Someone else is already refreshing — wait for their answer instead of
  // starting a second one.
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, setSession, clear } = useAuthStore.getState();

    if (!refreshToken) {
      clear();
      return null;
    }

    try {
      const response = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        // The refresh token is dead — expired, revoked, or the family was burnt
        // because someone replayed it. Either way there is no way back except a
        // fresh login.
        clear();
        return null;
      }

      const tokens = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };

      setSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });

      return tokens.accessToken;
    } catch {
      clear();
      return null;
    } finally {
      // Release the lock whatever happened, or the app can never refresh again.
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Internal: stops a refresh loop by ensuring we only ever retry once. */
  _isRetry?: boolean;
}

/**
 * The one function every data call goes through.
 *
 * Attaches the token, parses the envelope, converts failures into a typed error,
 * and refreshes-then-retries exactly once on a 401.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, _isRetry, headers, ...rest } = options;
  const token = useAuthStore.getState().accessToken;

  const response = await fetch(`${API_URL}/api/v1${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && !_isRetry) {
    const fresh = await refreshAccessToken();

    // Retry once with the new token. `_isRetry` guarantees that a second 401 —
    // which would mean the new token is *also* rejected — surfaces as an error
    // instead of recursing forever.
    if (fresh) {
      return apiFetch<T>(path, { ...options, _isRetry: true });
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload as ApiError | null;

    throw new ApiRequestError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? 'Something went wrong.',
      error?.details,
      error?.requestId,
    );
  }

  return payload as T;
}

/** Envelope every list endpoint returns. */
export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}
