# Security tests

Ten checks, run manually against a locally seeded database on 2026-09-18, plus the automated
suite in `tests/integration/`. Base URL `http://localhost:5000/api/v1`.

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| 1 | Citizen token on `GET /admin/users` | 403 `FORBIDDEN_ROLE` | **pass** |
| 2 | Citizen B patches Citizen A's complaint | 403 `NOT_OWNER` | **pass** |
| 3 | Repeated wrong passwords | 423 `ACCOUNT_LOCKED` (see note) | **pass** (429 first) |
| 4 | 6 wrong login OTPs | challenge deleted, then 400 `OTP_EXPIRED` | **pass** |
| 5 | Same login OTP used twice | second attempt 400 | **pass** |
| 6 | Access token used after logout | 401 `TOKEN_REVOKED` | **pass** |
| 7 | Old refresh token replayed | 401, every session of that user revoked | **pass** |
| 8 | `{"role":"ADMIN"}` in the register body | 400 `VALIDATION_ERROR` | **pass** |
| 9 | `.exe` renamed to `.jpg` uploaded | 400 (magic-byte check) | **pass** |
| 10 | `/payments/success` with a fabricated `val_id` | 400, payment stays `PENDING` | **pass** |

## Evidence

**1 — role guard**

```
GET /admin/users   Authorization: Bearer <citizen>
{"success":false,"message":"Forbidden: insufficient role",
 "errors":[{"code":"FORBIDDEN_ROLE","message":"Forbidden: insufficient role"}]}
```

**2 — ownership**

```
PATCH /complaints/<citizen A's id>   Authorization: Bearer <citizen B>
{"success":false,"message":"You do not own this complaint",
 "errors":[{"code":"NOT_OWNER","message":"You do not own this complaint"}]}
```

**3 — lockout.** Both controls exist, and the per-IP one is tighter: `authLimiter` allows five
requests per IP per 15 minutes on `/auth/login`, so from a single IP the sixth attempt is
`429 RATE_LIMITED` before the per-account counter can reach `423 ACCOUNT_LOCKED`. The account
lockout is reached when attempts arrive from different addresses, and is covered by the unit
path in `login()` (5 failures → 15 min, 10 → 1 h). This is a deliberate spec interaction, not a
gap — the tighter limit simply wins.

**5 — single-use OTP.** `redis.del(key)` is the winner check: whichever request deletes the key
first proceeds, and the loser gets `400 OTP already used`. That is race-safe without a lock.

**6 — logout denylist**

```
POST /auth/logout   → 200
GET  /users/me      (same token)
{"success":false,"message":"Token revoked","errors":[{"code":"TOKEN_REVOKED",…}]}
```

**7 — refresh reuse**

```
POST /auth/refresh-token { old token }
{"success":false,"message":"Refresh token reuse detected, all sessions revoked",
 "errors":[{"code":"TOKEN_REVOKED",…}]}
```
A `SecurityEvent TOKEN_REUSE` row is written and every session of that user is revoked, so the
token the attacker rotated to is dead as well.

**8 — mass assignment**

```
POST /auth/register {"name":…,"email":…,"password":…,"role":"ADMIN"}
{"success":false,"message":"Validation failed",
 "errors":[{"field":"body","code":"VALIDATION_ERROR","message":"Unrecognized key: \"role\""}]}
```

**9 — upload content check.** Multer's MIME filter runs first, then `verifyImage` reads the
actual bytes with `file-type`. A renamed executable fails the second check with
`"File content does not match its extension"`.

**10 — payment forgery.** `confirm()` calls the gateway's validation API and requires
`status ∈ [VALID, VALIDATED]`, a matching `tran_id`, an amount equal to the stored `Decimal`, and
currency `BDT`. A fabricated `val_id` fails, the response is 400, and the payment row is never
moved out of `PENDING`.

## Also verified

- **Stored XSS.** A comment body of `<script>alert(1)</script>Kobe thik hobe?` was persisted as
  `Kobe thik hobe?` — `sanitize-html` with `allowedTags: []`.
- **Append-only audit log.** `UPDATE` and `DELETE` on `AuditLog` both raise
  `AuditLog is append-only` at the database level.
- **Rating constraint.** Inserting `Feedback.rating = 9` violates `feedback_rating_ck`.
- **Optimistic lock.** Two simultaneous `PATCH /complaints/:id/status` produced exactly one
  `200` and one `409 CONFLICT`.
- **Pagination cap.** `?limit=1000` answers with `meta.limit = 100`.
- **Sort whitelist.** `?sortBy=hack` answers 400 with the allowed list in the message.
- **Enumeration.** An unknown email on `/auth/login` returns the same `Invalid credentials` after
  a dummy bcrypt compare; `/auth/forgot-password` and `/auth/resend-otp` answer identically
  whether or not the address exists.
- **Env hygiene.** `grep -R "process.env" src` matches only `src/config/env.ts`.

## Re-running

```bash
pnpm test                       # includes the automated versions of 1, 2, 5, 6, 7, 8
TEST_DATABASE_URL=… pnpm test   # throwaway database only — these tests truncate
```
