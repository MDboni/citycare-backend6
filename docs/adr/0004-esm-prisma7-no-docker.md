# ADR 0004 — ESM + Prisma 7 driver adapters, and no Docker

**Status:** accepted · 2026-09-18

## Decision

Three deviations from the original build specification:

1. The project is **ESM** (`"type": "module"`, `module: ESNext`), not CommonJS.
2. **Prisma 7** with the `prisma-client` generator and the `@prisma/adapter-pg` driver adapter,
   not `prisma-client-js`.
3. **No Docker.** The project runs directly with `pnpm` against hosted Postgres and Redis.

## Why

The repository was already initialised with Prisma 7, Express 5, Zod 4 and TypeScript 7, and the
lockfile pinned them. Prisma 7 is ESM-first and *requires* a driver adapter for SQL providers, so
the CommonJS layout in the specification would have meant downgrading a working, already
installed toolchain. `file-type`, which performs the magic-byte upload check, is ESM-only as
well. Docker was dropped because the user asked for a plain `pnpm run dev` workflow.

## Alternatives considered

- **Downgrade to Prisma 6 + CommonJS** to match the spec exactly — more spec-faithful, but it
  throws away the newer toolchain for no functional gain and reintroduces the ESM-only
  dependency problem.
- **Keep ESM but skip `@/` path aliases** — avoids build-time rewriting, at the cost of deep
  relative import chains the spec explicitly rejects.

## Consequences

- Every internal import carries a `.js` extension (`@/lib/prisma.js`) so the emitted JavaScript
  runs under Node's ESM resolver unchanged.
- `pnpm run build` runs `tsc` and then `tsc-alias --resolve-full-paths`, which rewrites the `@/`
  aliases to relative specifiers in `dist/`.
- `prisma.config.ts` holds the datasource URL and points at the `prisma/schema` folder, so the
  schema can be split across ten files.
- The generated client lives in `src/generated/prisma` and is git-ignored; `prisma generate`
  runs as the first step of every build.
- Everything else in the specification — architecture, response envelope, security controls,
  state machine, audit rules — is unchanged.
