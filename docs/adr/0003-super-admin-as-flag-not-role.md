# ADR 0003 — Super admin is a flag, not a fourth role

**Status:** accepted · 2026-09-18

## Decision

The system has exactly three roles: `CITIZEN`, `OFFICER`, `ADMIN`. A super admin is an `ADMIN`
row with `isSuperAdmin = true`.

## Why

A fourth role would have to be added to every role check, every transition entry and every
permission table, and every one of those places is a chance to forget it. A boolean on top of
ADMIN means super admins inherit the entire admin surface by construction, and only the handful
of genuinely dangerous actions — creating admins, approving refunds, restoring deleted data,
changing settings — check the extra flag.

## Alternatives considered

- **A fourth `SUPER_ADMIN` role** — every `authorize("ADMIN")` becomes
  `authorize("ADMIN", "SUPER_ADMIN")`, and the one that is missed is a privilege bug.
- **A permissions table** — the right answer at ten times this size; overkill for four actions.

## Consequences

- `isSuperAdmin` is never placed in a JWT. The auth middleware reads it from the database on
  every request, so revoking it takes effect immediately.
- No API can set the flag. Only the seed script does, and a database CHECK constraint
  (`isSuperAdmin = false OR role = 'ADMIN'`) blocks it from landing anywhere else.
- At least one active super admin must exist. Blocking, deleting or demoting the last one is
  refused inside a transaction with `409 LAST_SUPER_ADMIN`.
