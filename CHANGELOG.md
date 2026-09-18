# Changelog

All notable changes to this project are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-18

First complete build of the CityCare backend.

### Added

**Core**
- Express 5 application with helmet, a CORS whitelist from env, `hpp`, a 1 MB body limit,
  request ids and pino logging with a redaction list.
- Zod-validated configuration in `src/config/env.ts`; the process refuses to start without the
  required secrets.
- One response envelope for every endpoint, including 404, 429 and 500, and a global error
  handler that maps Zod, Prisma, JWT and Multer errors onto it.
- Graceful shutdown with server, database and Redis draining, plus a 10 s hard timeout;
  `headersTimeout` 15 s and `requestTimeout` 30 s.
- `/health`, `/ready` (Postgres + Redis) and `/metrics` behind an ADMIN token.

**Database**
- 29 Prisma models and 11 enums, split across nine schema files.
- A raw SQL migration adding CHECK constraints, partial unique indexes, trigram search indexes,
  a partial index for the SLA cron, and an append-only trigger on `AuditLog`.
- An idempotent seed: super admin, 3 officers, 5 citizens, 2 zones, 10 wards, 4 departments,
  10 categories, 5 service types, 20 complaints with history, and the system settings.

**Auth**
- Redis-first signup: nothing reaches PostgreSQL before the emailed OTP is verified.
- A two-factor challenge can be completed two ways: type the six digits, or open the sign-in link
  in the same email (`GET /auth/login/magic`). They are two doors into one challenge, not two
  credentials — whichever is used first ends it, a resend replaces both, and the link is 32 random
  bytes stored only as a SHA-256, valid five minutes, usable once, and never issues a trusted
  device.
- Login with a second factor, on by default for every account, opt-out for citizens only, and
  trusted devices. The seed leaves it off on the demo accounts so they can be evaluated without
  a mailbox.
- Progressive lockout, a per-IP failure counter, and a dummy bcrypt compare so an unknown email
  answers in the same way and the same time as a wrong password.
- Access tokens with a `jti` denylist on logout; refresh tokens hashed, rotated, and revoking
  every session on reuse.
- Google OAuth by redirect and by id token, both feeding the same account-creation path.
- Password reset and change, session listing and revocation, `PATCH /auth/2fa`.

**Domain**
- Complaints: race-safe tracking ids, SLA due dates, a duplicate guard, a nine-state machine
  with an optimistic lock, assignment with a department check and least-loaded auto-assign,
  attachments with a resolution-proof requirement, comments with staff-only internal notes,
  upvotes that raise priority at ten, feedback that closes a resolved complaint, public tracking
  and a `nearby` search.
- Service requests and SSLCommerz payments: one idempotent `confirm()` shared by the redirect
  and the IPN, every raw callback stored before processing, and a two-person refund flow.
- Notifications, master data with Redis caching and invalidation, user profile, avatar upload
  and data export.
- Admin: user and officer management, super-admin-only actions with a last-super-admin guard,
  dashboard statistics from `groupBy` only, audit logs, security events, an SLA report and a
  streamed CSV export.

**Operations**
- Hourly SLA escalation (levels 1–3) with auto-close after seven days without feedback.
- Daily retention purge that anonymises accounts deleted more than 30 days ago while keeping
  their complaints and payments.
- Prometheus metrics, Swagger UI at `/api/v1/docs`, and PDF receipts.

**Quality**
- Vitest unit tests for the transition map, pagination, the sort whitelist, OTP hashing, the
  tracking-id format and the response envelope; Supertest integration tests for the priority
  cases.
- A Postman walkthrough, [`docs/postman-guide.md`](docs/postman-guide.md), verified end to end
  against a running server. The collection chains tokens and ids through test scripts: a login
  stores its access token under the variable its role needs, and every created id is captured for
  the requests that follow.
- The collection is ordered for clicking through: ten numbered folders with numbered requests
  inside them, sub-folders for master data, complaints and admin, an assertion on every request so
  the Tests tab is green or red at a glance, and a ⚠ on the ones that delete something or end your
  session. Writes create their own rows under timestamped names, so no seeded record is ever
  renamed or deleted by testing. 80 of 80 assertable requests pass against a seeded database.

### Changed

- `authLimiter` counts **failed** attempts only. What it defends against is guessing, and a
  successful login is not a guess — counting it locked out the one person who typed the right
  password while a bot that fails every time got the same five tries either way.
- The global and auth rate limits are now `RATE_LIMIT_GLOBAL_MAX` and `RATE_LIMIT_AUTH_MAX`,
  defaulting to the same 100 and 5. A walkthrough of the whole API is about a hundred calls from
  one IP, which was the entire budget.

### Fixed

- A deliberate `429` raised inside an OTP flow — the 60 second resend cooldown, the hourly send cap
  — was being swallowed by the Redis wrapper and answered as `503 SERVICE_UNAVAILABLE`. Only an
  unexpected failure means Redis is the problem; an `ApiError` now passes straight through.
- GitHub Actions running lint, typecheck, migrations, tests with coverage, `pnpm audit`,
  gitleaks and the build against Postgres and Redis services.
- Biome, husky, lint-staged and commitlint.

### Notes

- Runs on ESM with Prisma 7 driver adapters; see
  [ADR 0004](docs/adr/0004-esm-prisma7-no-docker.md).
- No Docker: the project runs directly with `pnpm` against hosted Postgres and Redis.
