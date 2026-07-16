import { envSchema, type Env } from './env.schema';

/**
 * Parses and validates `process.env` against the schema.
 *
 * Registered as the ConfigModule `load` function, so it runs exactly once
 * during bootstrap. Throwing here aborts startup by design.
 */
export function loadConfiguration(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Print every problem at once — fixing env vars one crash at a time is
    // miserable, so surface the whole list.
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

/**
 * Typed accessor for ConfigService. Use as:
 *   `configService.get('JWT_ACCESS_SECRET', { infer: true })`
 * which then returns `string` rather than `string | undefined`.
 */
export type AppConfig = Env;
