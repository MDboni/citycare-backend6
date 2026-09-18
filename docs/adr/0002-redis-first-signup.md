# ADR 0002 — Redis-first signup

**Status:** accepted · 2026-09-18

## Decision

A pending signup lives in Redis for 10 minutes. No `User` row is written to PostgreSQL until
the emailed OTP has been verified.

## Why

The usual alternative — create the user immediately with `emailVerifiedAt = null` — leaves the
database full of unverified rows that anyone can create at will. Those rows occupy email
addresses, distort statistics, and have to be cleaned up by yet another job. Worse, they leak
information: registering with someone else's address tells you whether that address is taken.

Keeping the pending record in Redis means an abandoned or attacked signup expires by itself and
leaves nothing behind.

## Alternatives considered

- **Unverified user rows + cleanup cron** — simple, but every problem above stays.
- **Signed verification token in a link** — no server state, but it cannot enforce an attempt
  limit or a resend cooldown per address.

## Consequences

- Redis becomes a hard dependency for signup (it is soft everywhere else). A Redis outage during
  signup answers `503`, not `500`.
- The password is bcrypt-hashed and the OTP is HMAC-hashed *before* being stored in Redis, so a
  leaked Redis dump yields neither.
- Attempts and resend counters live next to the pending record, so the limits are trivial.
