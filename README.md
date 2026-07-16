<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
  <img src=".github/assets/logo-light.svg" alt="Nexora" width="300">
</picture>

### The AI Business Operating System for small business

**Nexora runs your business while you grow it — managing sales, stock and money,<br>and doing the busywork itself.**

<br>

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#built-on)
[![Next.js](https://img.shields.io/badge/Next.js-App%20Router-000000?logo=nextdotjs&logoColor=white)](#built-on)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](#built-on)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-multi--tenant-4169E1?logo=postgresql&logoColor=white)](#trust-is-the-product)
[![Status](https://img.shields.io/badge/status-in%20development-8B5CF6)](#where-the-product-stands)

</div>

---

## Software that works your data, instead of just storing it

Every business tool you have ever used is a filing cabinet. You feed it — leads, invoices, stock counts — and when you need an answer, *you* do the digging.

Nexora inverts that. Every record you create comes back to you **worked**:

- Add a lead → it arrives **scored**, with the reasons and the next step to take
- Open a deal → it carries a live **win probability**, anchored to your own pipeline's history
- Watch your board → the forecast is **weighted by what actually closes**, not by optimism

The AI is not a chatbot bolted onto the corner of the screen. It is woven into the records themselves — and when it has nothing useful to say, it says nothing, and the software still works like the best CRM you've used.

> **The goal, in one number: cut the busywork of running a small business by 70%.**

---

## What Nexora does today

### 🎯 Sales CRM — live now

| | |
|---|---|
| **Leads with AI scoring** | Every lead is scored 0–100 in the background, with the model's reasoning a hover away. Your list sorts hottest-first, so the morning starts at the top. |
| **Deal pipeline** | A Kanban board with drag-and-drop *and* full keyboard control. Won deals stamp the books; lost deals demand a reason — captured in the moment it's still true. |
| **Honest forecasting** | The pipeline total is weighted by each stage's real win rate. Won deals are revenue, not predictions — Nexora never counts the same rupee twice. |
| **Customers & churn risk** | Accounts sorted by who needs attention, not by alphabet. |

### 👥 A real team product — live now

- Invite your team with one link; seats and roles enforced automatically
- Ten roles out of the box, every permission editable per workspace
- Fired employee? Access revoked on their **next request** — not in fifteen minutes
- Every important action lands in an append-only audit trail

### 💳 Fair, simple commerce — live now

- **14-day full trial, no card required** — the AI included, because that's what you're evaluating
- Per-seat pricing that grows with you, in ₹, built for Indian payments (UPI AutoPay, cards, netbanking via Razorpay)
- **Your data is never held hostage.** If your subscription lapses, the workspace goes *read-only* — you can always see and export everything you own. Always.

| Plan | Per seat / month | What you get |
|---|---|---|
| **Starter** | ₹499 | The full CRM, exports |
| **Growth** ⭐ | ₹999 | Everything in Starter + **AI scoring & forecasting**, audit trail |
| **Enterprise** | ₹1,999 | Everything in Growth + SSO, controls, and a phone number to call |

### 🗺️ Where it's going

Inventory with shortage prediction · Accounting with GST returns and OCR'd receipts · Purchase & vendor management · HR with attendance and payroll · Customer support with AI-drafted replies · An assistant you can simply ask: *"summarize today's business"* · AI agents that follow up leads, chase invoices, and reorder stock before it runs out · Mobile apps · Stripe/Shopify/Tally integrations

The architecture is module-per-vertical by design — each new module clones a pattern that already works in production, rather than solving new problems.

---

## Trust is the product

An SMB putting its books into your software is an act of trust. Nexora's three hardest guarantees are architectural, not promises in a policy page:

1. **Companies cannot see each other's data — even by our mistake.**
   Tenant isolation is enforced *below* the application: a database query that isn't scoped to your company **throws an error** instead of returning someone else's rows. It is not possible to forget.

2. **Your data is yours, in every scenario.**
   Expired trial, bounced card, cancelled plan — reads and exports keep working. Nothing is deleted, hidden, or ransomed. The lock only stops *new* writing, and paying always unlocks instantly.

3. **Access control acts in real time.**
   Passwords are Argon2id. Sessions rotate on every refresh, and a stolen token trips an alarm instead of granting silent access. Permissions are checked live on every request.

*(Engineers: the full design rationale is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).)*

---

## Run it locally

```bash
git clone https://github.com/Fahadjari/nexora.git && cd nexora
npm run setup        # installs, starts Postgres/Redis/MinIO, migrates, seeds
npm run dev:api      # → http://localhost:4000/api/v1  (docs at /api/docs)
npm run dev:web      # → http://localhost:3000
```

Sign in as `priya@acmetrading.in` / `nexora-demo-2026` — a seeded demo company with leads, deals and a live pipeline. Two demo companies are seeded on purpose: log in as each and try to see the other's data. You can't. That's the point.

**AI keys are optional.** Set `ANTHROPIC_API_KEY` (or OpenAI / Gemini) in `.env` to switch the intelligence on; without one, everything else runs fine. **Payment keys are optional too** — the trial takes no card, so the whole product works before Razorpay is ever configured.

---

## Built on

**Next.js** (App Router) · **NestJS** · **TypeScript** end to end · **PostgreSQL** + Prisma · **Redis** + BullMQ for background work · **Razorpay** for subscriptions · a provider-agnostic AI layer speaking to **Anthropic, OpenAI or Gemini** — with automatic failover, because a lead score from your second-choice model beats no score from your first.

## Where the product stands

Nexora is in active development. The sales CRM, team management, and the complete subscription/trial/billing engine are **built and verified** — including the unglamorous parts (webhook idempotency, seat-limit enforcement, grace periods for failed payments). The remaining business modules are being added vertical by vertical on the same foundation.

<div align="center">
<br>

<img src=".github/assets/mark.svg" alt="" width="40">

**Nexora** — *stop feeding software.*

</div>
