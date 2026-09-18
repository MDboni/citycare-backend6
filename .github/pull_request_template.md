## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves, not the diff. -->

## How to verify

<!-- Exact commands or requests a reviewer can run. -->

## Checklist

- [ ] `pnpm run lint` and `pnpm run typecheck` pass
- [ ] `pnpm test` passes
- [ ] Every new body schema uses `.strict()`
- [ ] Ownership is checked in the service, not only the route
- [ ] Critical actions write an `AuditLog` row
- [ ] No secret, token or OTP is logged or returned
- [ ] Docs / Postman collection updated if the API changed
