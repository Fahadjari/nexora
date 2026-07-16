# Nexora — Architecture

This document explains the decisions that shape the codebase. The product
pitch lives in the [README](../README.md); this is for people working on it.

The platform is built as a **foundation plus vertical slices**. The first slice
(CRM) proved the architecture — tenancy, auth, permissions, auditing, background
work, AI. The second (billing + team) proved the commercial layer. Every module
after these repeats a pattern that already works, rather than solving fresh
problems.

---

## The decisions that shape everything else

### 1. Multi-tenancy is enforced below the application, not inside it

Every business record carries a `tenantId`, and **no service ever writes one**.
A Prisma client extension ([`tenant-scope.extension.ts`](../apps/api/src/modules/prisma/tenant-scope.extension.ts))
injects it into every query — into `where` for reads, into `data` for creates —
reading the current tenant from an `AsyncLocalStorage` context.

This is the difference between "we remember to filter by tenant" and "it is not
possible to forget." The usual approach threads a `tenantId` argument through
every function, and it works right up until one call site forgets — at which
point one company is reading another's books. Here, a query that reaches the
database with no tenant in context **throws**, rather than returning everything.

Consequences worth knowing:

- Feature services inject `TENANT_DB`, never the raw `PrismaService`. The raw
  client is unscoped and exists only for login (which must find a user *before*
  it knows their workspace), webhooks (which arrive with no user at all), the
  seeder, and health checks. Every use of `runCrossTenant()` is greppable and
  should read as deliberate in review.
- Background jobs carry `tenantId` in the job payload and re-establish the scope
  with `runInTenant()`. A worker has no request, therefore no context — so the
  tenant has to travel with the job.
- Models without a `deletedAt` column must be listed in
  `SOFT_DELETE_EXEMPT_MODELS`, or the extension's soft-delete filter would make
  Prisma throw on an unknown argument.

Verified by unit tests covering the attack cases (passing another tenant's id,
planting a record in someone else's workspace) and by an end-to-end test that
registers two real companies and has one try every route to reach the other's
data. The seed creates **two** populated companies for exactly this reason — a
single-tenant seed makes cross-tenant leaks invisible.

### 2. AI is provider-agnostic, and its failure is never fatal

Feature code speaks one vocabulary ([`ai.types.ts`](../apps/api/src/modules/ai/ai.types.ts));
adapters translate it for Anthropic, OpenAI and Gemini. `AiService` retries with
jittered backoff, then **fails over across vendors** — a lead score from Gemini
beats no lead score because Anthropic had a bad ten minutes.

The abstraction is honest about where providers genuinely disagree:

- **`temperature` is a hint, not a contract.** Current Claude models *reject* it
  with a 400. Adapters that can't honour it drop it.
- **Structured output is requested, not spelled.** Anthropic constrains decoding
  via `output_config.format`, OpenAI via `response_format`, Gemini via
  `responseSchema`. Callers state the schema; each adapter reaches for its own
  mechanism.

And the rule that matters operationally: **AI never blocks a user's work.**
Creating a lead returns immediately; scoring happens on a queue. If every
provider is down, the lead still saves — it just saves without a score.

### 3. Auth fails closed

`JwtAuthGuard` is registered globally, so **every route is protected the day it
is written**; opting out requires an explicit `@Public()`. An omission is a 401,
not a breach.

- Refresh tokens are **rotated on every use**, and reuse of a spent token revokes
  the entire token family — turning a stolen refresh token from indefinite,
  invisible access into one stolen session that trips an alarm.
- Permissions are resolved **per request** from a cache that is explicitly
  invalidated on change, not baked into the token. Revoking someone's access
  takes effect on their next request, not in fifteen minutes.
- Passwords are Argon2id; TOTP secrets are AES-256-GCM encrypted; refresh tokens
  are stored as SHA-256 fingerprints.

### 4. Billing is enforced the same way auth is — globally, failing closed

`SubscriptionGuard` sits right after `JwtAuthGuard` in the global guard chain.
The full guard order and the reasoning:

```
1. throttle       — cheapest possible rejection, before any work
2. authenticate   — who are you?           (writes identity into context)
3. subscription   — has your company paid? (reads that identity)
4. authorize      — may *you* do this specific thing?
```

The shape of the enforcement:

- **Reads are never blocked.** A lapsed customer can always see and export their
  own books. The lock is read-only, never a blackout — holding a company's data
  hostage over an expired card is how a vendor earns a chargeback and a lawsuit.
- **Writes are refused with `402 Payment Required`**, carrying a machine-readable
  code so the client renders an upgrade prompt, not a dead error.
- **`@BillingExempt()` marks the routes a locked-out customer needs to get
  unstuck** — billing itself, auth, invite acceptance, health. A lock that
  prevents the payment that would lift it is a bug, not a business model.
- **A feature gate (`@RequiresFeature`) is a 402, not a 403.** A permission is
  about the person; a plan is about the company. Conflating them turns "upgrade
  to Growth" into a support ticket.

Entitlements are a **pure function** of (billing state, clock) —
[`entitlements.ts`](../apps/api/src/modules/billing/entitlements.ts) — so "the
trial expires on day 15" is a unit test, not a two-week wait. The state is
cached in Redis for 60 seconds and invalidated explicitly on every billing
write; enforcement never waits for the hourly maintenance sweep, which exists
only to keep *stored* statuses honest for reporting.

Two rules with money on the line:

- **Only a verified webhook may mark a subscription paid.** The checkout
  redirect proves the user reached a page, nothing more. Signatures are HMACs
  over the **raw body bytes** (re-serialised JSON does not reproduce them),
  compared with `timingSafeEqual`, and every event id is recorded under a unique
  index — the insert *is* the idempotency check, because providers deliver
  duplicates by contract.
- **Seats count promises, not just people.** The seat check counts pending
  invitations as used seats; otherwise an owner could fire off twenty invites on
  a five-seat plan and have them all land.

### 5. The payment provider is an adapter, like the AI providers

Nothing outside `billing/providers/` may import a vendor SDK or name a vendor
concept ([`payment.types.ts`](../apps/api/src/modules/billing/payment.types.ts)
is the vocabulary). Razorpay is the first adapter — chosen because India's
recurring-payment rules (UPI AutoPay mandates) are native to it — and it is
implemented over plain REST: the surface is four calls and an HMAC, not worth a
dependency tree in the one module where a compromised transitive dependency is
worst.

Plans live in **code**, not in a database table
([`plans.ts`](../apps/api/src/modules/billing/plans.ts)), for the same reason
the permission catalogue does: pricing is part of the product, reviewed and
versioned. We send the provider a plan id, never an amount — a bug in our code
cannot charge a price we never published.

---

## Layout

```
apps/api          NestJS. Feature-per-folder under src/modules.
  prisma/         Schema, migrations, seed (two demo companies, on purpose)
  src/common/     Request context, decorators, error filter, crypto
  src/modules/
    prisma/       Tenant-scoped client        ← the isolation boundary
    auth/         JWT, rotation, 2FA, registration (creates the trial)
    rbac/         The permission catalogue
    audit/        Append-only trail, with secret redaction
    ai/           Provider abstraction + adapters (Anthropic/OpenAI/Gemini)
    billing/      Plans, entitlements, guard, Razorpay adapter, webhooks
    members/      Invitations, roles, seat enforcement
    crm/          The first vertical: leads, customers, deals, AI scoring
apps/web          Next.js App Router. Feature-per-folder under src/features.
  src/lib/        API client (single-flight refresh, typed errors), auth store
  src/components/ UI primitives, app shell
  src/features/   leads, customers, deals — hooks + dialogs per feature
```

## Commands

| | |
|---|---|
| `npm run setup` | Install, start infra, migrate, seed — the one-command bootstrap |
| `npm run dev:api` / `dev:web` | API / web in watch mode |
| `npm test` | Unit tests |
| `npm run test:e2e -w @nexora/api` | End-to-end (needs infra up) |
| `npm run db:studio` | Browse the database |
| `npm run infra:reset` | Wipe and recreate Postgres/Redis |

## Verification discipline

Nothing is called done on the strength of a typecheck. The pipeline forecast
was verified to the rupee against the live API; the billing flows were driven
end-to-end (register → trial → invite → seat limit → forced expiry → 402 on
writes, 200 on reads); tenant isolation is attacked, not assumed, by tests that
try to cross the boundary. Keep it that way: when you add a rule with money or
isolation on the line, add the test that tries to break it.
