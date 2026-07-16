import { z } from 'zod';

/**
 * The single source of truth for every environment variable the API reads.
 *
 * Validated once at boot (see `configuration.ts`). A malformed or missing
 * variable crashes the process on startup rather than surfacing as a confusing
 * runtime error under load — a container that refuses to start is caught by the
 * deploy; one that starts and misbehaves is caught by a customer.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:3000'),

  // --- Database ---
  DATABASE_URL: z.string().url(),

  // --- Cache / queue ---
  REDIS_URL: z.string().url(),

  // --- Auth ---
  // 32 chars is the floor for a secret that has to survive being public-facing.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // --- OAuth (optional: unset providers are simply not offered) ---
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),

  // --- AI ---
  AI_DEFAULT_PROVIDER: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

  // --- Billing (optional) ---
  //
  // Deliberately optional, and that is a product decision, not laziness: the
  // 14-day trial takes no card, so the entire platform — signup, invites, the
  // whole CRM — runs end to end with no payment keys at all. You only need these
  // to take money, and you find out they are missing at exactly that moment.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Plan ids, created once in the Razorpay dashboard. We send a plan id, never
  // an amount, so a bug here cannot charge a price we never published.
  RAZORPAY_PLAN_STARTER: z.string().optional(),
  RAZORPAY_PLAN_GROWTH: z.string().optional(),
  RAZORPAY_PLAN_ENTERPRISE: z.string().optional(),

  // --- Object storage ---
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('nexora'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
});

export type Env = z.infer<typeof envSchema>;
