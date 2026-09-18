# Contributing

## Setup

```bash
pnpm install
cp .env.example .env      # fill in the values
pnpm exec prisma generate
pnpm run db:migrate
pnpm run db:seed
pnpm run dev
```

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Deployed. Protected |
| `dev` | Integration |
| `feat/<module>-<task>` | A feature |
| `fix/<bug>` | A fix |

Feature branch → PR into `dev`. Release by merging `dev` into `main` and tagging.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint on
`commit-msg`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`.

```
feat(auth): add login with 2fa otp challenge and account lockout
fix(payment): reject a callback whose amount does not match the stored one
docs: add the architecture and payment flow documents
```

One feature, one commit. Commit as each piece of work lands, not one giant commit per phase.

## Architecture rules

These are not style preferences — a PR that breaks one will be sent back.

1. **Route → Middleware → Controller → Service → Prisma.** No shortcuts.
2. **Controllers contain no business logic** and never call Prisma. Read validated input, call
   one service function, send the response.
3. **Services never touch `req` or `res`.** They take a plain `ctx` object, which is what lets
   the cron jobs reuse them.
4. **One module, four files:** `<name>.route.ts`, `<name>.controller.ts`, `<name>.service.ts`,
   `<name>.validation.ts`, plus optional `.types.ts` / `.constants.ts`.
5. **Every response uses the envelope** — including 404, 429 and 500.
6. **`process.env` appears only in `src/config/env.ts`.** Everything else imports `env`.
7. **No `any`.** Infer from Zod with `z.infer`.
8. **Only `throw new ApiError(...)`.** No `try/catch` in controllers.
9. **Imports use the `@/` alias with a `.js` extension** (`@/lib/prisma.js`) — that is what makes
   the compiled ESM output run under Node unchanged.
10. **A function over 40 lines wants splitting.**

## Security rules

- Every body schema ends in `.strict()`. `role`, `status` and `isSuperAdmin` are never accepted
  from a client.
- Every service method that takes an `:id` checks ownership. The route guard is not enough.
- Every critical action writes an `AuditLog` row **inside the same transaction** as the change.
- Free text goes through `sanitize-html` before it is stored.
- Never log or return a password, token or OTP.
- Never use `$queryRawUnsafe`. If raw SQL is genuinely needed, use a tagged `$queryRaw`.

## Before you open a PR

```bash
pnpm run lint
pnpm run typecheck
pnpm test
```

Add a test with any behaviour change: a unit test for pure logic, an integration test for
anything that touches a route. Update `docs/openapi.yaml` and the Postman collection if the API
surface moved.

## Reviewing

- Does it hold the architecture rules above?
- Is ownership checked in the service?
- Is the response envelope intact on both the success and the error path?
- Could a second, concurrent request break it? Is a transaction or an optimistic lock needed?
- Does anything secret reach a log, a response or an email?
