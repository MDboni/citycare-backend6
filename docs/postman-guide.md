# Testing CityCare in Postman

Import two files, pick the environment, and click down the folders from 01 to 10. Tokens and ids
are captured as you go, every request checks its own status code, and nothing needs to be copied
by hand.

- Collection: [`docs/api/citycare.postman_collection.json`](api/citycare.postman_collection.json) — 99 requests, 10 numbered folders
- Environment: [`docs/api/citycare.postman_environment.json`](api/citycare.postman_environment.json) — 44 variables
- The same surface is browsable at `http://localhost:5000/api/v1/docs` (Swagger UI) and in
  [`docs/openapi.yaml`](openapi.yaml)

Everything below was run against a live server before it was written: 80 requests passed, 0
failed, the remaining 19 being the file uploads, the browser-only Google redirects, the gateway's
own callbacks and the ⚠ requests described in §4.

---

## 1. Before you open Postman

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL, REDIS_URL and the three secrets
pnpm run db:migrate
pnpm run db:seed
pnpm run dev                  # http://localhost:5000
```

The seed prints the demo accounts when it finishes. It is idempotent — running it twice is safe.

**Minimum to get through this guide:** PostgreSQL and Redis. SMTP, Cloudinary, SSLCommerz and
Google are each needed only for the section that names them.

### One setting to change before a walkthrough

A full pass is about a hundred calls from one IP, and the global limiter allows exactly a hundred
per fifteen minutes. Raise it in `.env` while you are testing:

```
RATE_LIMIT_GLOBAL_MAX=1000
RATE_LIMIT_AUTH_MAX=50
```

The production defaults are `100` and `5`, which is what `.env.example` ships and what a deployed
instance should keep. The auth limiter only counts *failed* attempts, but folder 02 contains
several requests that fail on purpose — a verify-otp without an OTP, a reset without a token — and
five of those is the whole budget.

---

## 2. Import

1. Postman → **Import** → drop in both JSON files from `docs/api/`.
2. Top right, select the environment **CityCare — local**.
3. Open the eye icon next to it to watch variables fill in as you work.
4. Open the Postman console (`Ctrl/Cmd + Alt + C`). Every capture prints there —
   `saved adminToken for ADMIN`, `complaintId = …` — which is the fastest way to see what a request
   did.

If the API is deployed somewhere, change two variables and nothing else:

| Variable | Local | Deployed |
| --- | --- | --- |
| `host` | `http://localhost:5000` | `https://your-app.onrender.com` |
| `baseUrl` | `http://localhost:5000/api/v1` | `https://your-app.onrender.com/api/v1` |

---

## 3. Demo accounts

| Role | Email | Password | Two-factor |
| --- | --- | --- | --- |
| Super admin | `admin@citycare.com` | `Admin@12345` | off |
| Officer (Roads, ward 1) | `officer1@citycare.com` | `Officer@12345` | off |
| Officer (Waste / Water) | `officer2@citycare.com`, `officer3@citycare.com` | `Officer@12345` | off |
| Citizen | `citizen1@citycare.com` | `Citizen@12345` | off |
| Citizen | `citizen2@citycare.com` … `citizen5@citycare.com` | `Citizen@12345` | **on** — needs an emailed OTP |

Two-factor is **on for every account created through the API**. The seed is the only thing that
can hand out an OTP-free staff account, which is what makes these credentials usable without a
mailbox. `PATCH /auth/2fa` still refuses to turn it off for anyone but a citizen — try it as the
admin and you get `403 FORBIDDEN_ROLE`.

---

## 4. How the collection is arranged

| Folder | What is in it | Needs |
| --- | --- | --- |
| **01 — Setup** | health, readiness, the three logins | run this first, always |
| **02 — Auth** | signup, OTP, 2FA, sessions, refresh, Google, password reset | 01 |
| **03 — User** | profile, avatar, export, delete | 01 |
| **04 — Master data** | Departments · Categories · Zones and wards · Service types | 01 |
| **05 — Complaint** | Create and browse · Lifecycle · Attachments and comments · Reactions and feedback | 01, 04 |
| **06 — Service request** | apply, documents, processing | 01, 04 |
| **07 — Payment** | initiate, callbacks, refunds | 06 + SSLCommerz keys |
| **08 — Notification** | list, mark read | 01 |
| **09 — Admin** | Users · Super admin only · Reports, audit and settings | 01 |
| **10 — Officer** | the officer's own workload | 01 |

Requests are numbered inside each folder in the order they are meant to be sent. **04 before 05**
matters: the list requests in Master data are what fill `categoryId`, `wardId` and
`serviceTypeId`.

### ⚠ means run it last

A request marked ⚠ deletes something or kills your token — logout, revoke session, change
password, delete account, soft-delete a complaint, remove an admin. Everything else is safe to
click in any order. After a ⚠ auth request, re-run folder 01 to get a fresh token.

### Every request checks itself

Each one asserts its own status code and that the answer uses the standard envelope, so the Tests
tab is green or red at a glance and the Collection Runner can take a whole folder at once. Where
more than one answer is legitimate the test says so — `Status is 200, 403 or 409` — and the
request description explains when you get which.

### Variables the scripts maintain

| Variable | Set by |
| --- | --- |
| `adminToken`, `officerToken`, `citizenToken` | any login, routed by the role in the response |
| `refreshToken`, `userId` | any login; refresh also rewrites `citizenToken` |
| `challengeId` | a `202` two-factor response |
| `otp` | **you type this in** — from the email, or the dev server log |
| `signupEmail` | a pre-request script, fresh on every send |
| `departmentId`, `categoryId`, `wardId`, `zoneId`, `serviceTypeId` | the Master data list requests — **seeded** rows, for reading |
| `newDepartmentId`, `newCategoryId`, `newWardId`, `newZoneId`, `newServiceTypeId` | the Master data create requests — rows **this run made**, safe to rename and delete |
| `complaintId`, `trackingId` | `POST /complaints` |
| `serviceRequestId`, `documentId` | `POST /service-requests`, document upload |
| `paymentId`, `transactionId` | `POST /payments/initiate` |
| `officerId`, `targetUserId` | `GET /admin/users` |
| `newOfficerId`, `newAdminId` | the admin create requests |
| `notificationId`, `sessionId` | the matching list requests |
| `idempotencyKey` | fixed at `demo-key-001` — see §6 |

Path parameters read these, so `GET /complaints/:id` resolves to the complaint you just created
without editing anything.

### What the collection does to your database

Writes never touch seeded rows. Every create stamps its name with the clock —
`Parks and Recreation 481902`, `Test Ward 613`, `officer.test.1789…@citycare.com` — and the update
and delete requests act on *that* row, so Roads, Mirpur 10 and Pothole are never renamed out from
under the seed and a second run cannot collide with the first.

What does accumulate is one extra department, category, zone, ward, service type, officer and
admin per run. `pnpm run db:seed` will not remove them; if you want a clean slate,
`pnpm exec prisma migrate reset` followed by the seed will give you one.

---

## 5. Walkthrough — a complaint from report to closed

This is the one to record. Run folders 01 and 04 first, then folder 05 top to bottom. The table
below adds what to change where the same request is sent more than once.

| # | Folder 05 request | Token | Change | Expect |
| --- | --- | --- | --- | --- |
| 1 | Create and browse → 01. Report a problem | citizen | — | `201` — saves `complaintId`, `trackingId` |
| 2 | Create and browse → 04. Public tracking | **none** | — | `200` — status, category, ward, timeline, no personal data |
| 3 | Lifecycle → 02. Move the complaint | **admin** | as shipped: `UNDER_REVIEW` | `200` |
| 4 | Lifecycle → 03. Assign an officer | **admin** | as shipped: `"auto": true` | `200` — status becomes `ASSIGNED` |
| 5 | Create and browse → 08. Complaints assigned to you | **officer** | — | `200` — it is in the list |
| 6 | Lifecycle → 02. Move the complaint | **officer** | `"status": "IN_PROGRESS"` | `200` |
| 7 | Lifecycle → 02. Move the complaint | **officer** | `"status": "RESOLVED"` | **`409`** — see below |
| 8 | Attachments → 01. Upload | **officer** | file + `kind` = `RESOLUTION_PROOF` | `201` |
| 9 | Lifecycle → 02. Move the complaint | **officer** | `"status": "RESOLVED"` | `200` |
| 10 | Reactions → 02. Rate a resolved complaint | citizen | — | `201` — the rating closes the complaint |
| 11 | Lifecycle → 04. Full status history | any | — | `200` — every hop with who made it and when |

**Step 7 is deliberate.** "Resolved" has to be provable: without at least one `RESOLUTION_PROOF`
attachment the transition is refused with
`{"code":"CONFLICT","message":"At least one RESOLUTION_PROOF attachment is required"}`. Step 8
supplies it. If Cloudinary is not configured, skip 7–9 and finish at step 6.

**Step 4 assigns automatically.** `"auto": true` picks the least-loaded active officer in the
category's own department, so the request stands on its own. To assign by hand, send
`{"officerId": "{{officerId}}", "auto": false}` and run **09 — Admin → Users → 01. List users**
first to fill `officerId`. An officer from another department is a `409`: a Roads complaint cannot
land on the Waste desk.

### The state machine, in full

`Lifecycle → 02. Move the complaint` is one request, but who may move where is fixed:

| From | To | Who |
| --- | --- | --- |
| `SUBMITTED` | `UNDER_REVIEW` | ADMIN |
| `SUBMITTED` | `CANCELLED` | CITIZEN (owner) |
| `UNDER_REVIEW` | `ASSIGNED` | ADMIN |
| `UNDER_REVIEW` | `REJECTED` | ADMIN (a `note` is required) |
| `ASSIGNED` | `IN_PROGRESS` | OFFICER (the assigned one) |
| `IN_PROGRESS` | `RESOLVED` | OFFICER (with resolution proof) |
| `RESOLVED` | `CLOSED` | CITIZEN or ADMIN |
| `RESOLVED` | `REOPENED` | CITIZEN |
| `REOPENED` | `ASSIGNED` | ADMIN |
| `CLOSED`, `REJECTED`, `CANCELLED` | — | terminal |

Anything else is `409 INVALID_TRANSITION`. There is no "admin can set any status" escape hatch.
An officer who is not the assignee gets `403 NOT_OWNER` even for a move their role allows.

### Worth trying while you are here

| Request | Token | Shows |
| --- | --- | --- |
| Reactions → 01. Upvote | citizen | one vote per person; at ten votes the priority moves up a step |
| Attachments → 02. Add a comment with `"isInternal": true` | officer | staff-only note — list the comments as the citizen and it is not there |
| Create and browse → 05. Search | any | trigram search over title and description, Bangla included |
| Create and browse → 06. Nearby | any | real Haversine distance, sorted nearest first |

---

## 6. Two guards that will surprise you

Both are working as designed, and both show up as a `409` or a replay rather than a fresh row.

**The duplicate guard.** The same citizen cannot have two *open* complaints in the same category
and ward inside 24 hours — the second is `409 DUPLICATE_COMPLAINT` naming the first one's tracking
id. Finish the lifecycle (a closed complaint no longer blocks), pick another `wardId`, or log in
as citizen2.

**Idempotency.** `POST /complaints` and `POST /payments/initiate` send
`Idempotency-Key: {{idempotencyKey}}`, fixed at `demo-key-001`.

| Send | Result |
| --- | --- |
| first | `201`, the complaint is created |
| again, unchanged | `201` again — byte-identical, with the header `Idempotent-Replay: true`, and **no second complaint** |
| again, body edited | `422 IDEMPOTENCY_MISMATCH` |

The stored answer lives 24 hours. So when you come back tomorrow — or when you want a genuinely
new complaint today — **change `idempotencyKey` in the environment**, otherwise you keep getting
the first answer back. The test script prints `REPLAY — …` in the console whenever that happens,
so you are never left guessing.

---

## 7. Signup and two-factor, without a mailbox

`POST /auth/register` writes **nothing** to PostgreSQL. The pending account lives in Redis for ten
minutes with the password bcrypt-hashed and the OTP HMAC-hashed; the row is created only when the
OTP is verified.

1. **02 — Auth → 01. Start signup** — a pre-request script puts a fresh address in `{{signupEmail}}`,
   so this never collides. → `202 { email: "c****e@example.com", expiresInSec: 600 }`
2. **Get the OTP.** With SMTP configured it is in the inbox. Without it, the dev server prints it:

   ```
   WARN: [dev only] signup OTP for citycare.1758…@example.com: 418902
   ```

   Paste the six digits into the `otp` environment variable.
3. **03. Verify the OTP** → `201` with tokens, and now the user exists.

Two-factor on login works the same way: change the login body to `citizen2@citycare.com` and you
get `202 { twoFactorRequired: true, challengeId }`. The script saves `challengeId`; put the OTP in
`otp` and send **05. Complete the two-factor challenge**. Set `"trustDevice": true` and the
response includes a `deviceToken` that skips the OTP next time — citizens only.

### Things to check in this folder

| Request | Expect | Why it matters |
| --- | --- | --- |
| 01. Start signup, with an email that already exists | `409 EMAIL_EXISTS` | |
| 01. Start signup, with `"role": "ADMIN"` added | `400` | every body is `.strict()`; no privilege field is ever accepted |
| 01. Start signup, with `"Rahim"` inside the password | `400` | the password may not contain your name or your email's local part |
| 02. Resend, twice inside a minute | `429 OTP_COOLDOWN` | |
| 04. Log in with a wrong password | `401 Invalid credentials` | an unknown email gives the identical answer, in the same time — a dummy bcrypt compare runs either way |
| 10. Email a reset link, unknown address | `200` | no account-existence oracle |
| 08. Rotate the refresh token, twice with the same token | `401` + every session revoked | reuse detection: a stolen refresh token is good for one use |
| 09. `PATCH /auth/2fa` with `{{adminToken}}` | `403 FORBIDDEN_ROLE` | staff cannot drop to a single factor |
| ⚠ 17. Log out, then any authed request | `401` | the token's `jti` is on a Redis denylist until it expires |

---

## 8. Service request, payment, refund

| # | Request | Token | Expect |
| --- | --- | --- | --- |
| 1 | 06 → 01. Apply for a paid service | citizen | `201`, status `PENDING_PAYMENT`, saves `serviceRequestId` |
| 2 | 06 → 05. Upload a supporting document | citizen | `201` — form-data `document` = a PDF, `label` = text |
| 3 | 07 → 01. Start a payment | citizen | `201` with `paymentUrl` — **or `503` if the gateway is not configured** |
| 4 | *(browser)* open `paymentUrl`, pay with the sandbox card | — | SSLCommerz redirects to `/payments/success` |
| 5 | 07 → 02. Your payment history | citizen | `200` — status `SUCCESS` |
| 6 | 06 → 07. Process a paid request | officer | `{"status":"PROCESSING"}` → `200` |
| 7 | 06 → 07. Process a paid request | officer | `{"status":"COMPLETED"}` → `200` |
| 8 | 07 → 08. Request a refund | admin | `201` — refund requested |
| 9 | 07 → 09. Approve and execute a refund | **super admin** | `200` — a different person must approve |

**Without SSLCommerz credentials**, step 3 answers:

```json
{ "success": false, "message": "Payment gateway is not configured",
  "errors": [{ "code": "SERVICE_UNAVAILABLE", "message": "SSLCommerz credentials are missing" }],
  "requestId": "93f6759d-a47b-41db-99d8-0481b3ed77f6" }
```

That is the correct answer, not a bug — set `SSL_STORE_ID` and `SSL_STORE_PASSWORD` in `.env` and
restart. Steps 6 and 7 need a *paid* request, so without the gateway they stay at `409
INVALID_TRANSITION`, which is also correct: processing only starts once the money is in.

The amount is **never** read from the request body — it comes from `ServiceType.fee` in the
database. The success callback and the IPN both call one idempotent `confirm(tranId, valId)`, so a
replayed callback cannot pay twice. See [`docs/payment-flow.md`](payment-flow.md).

---

## 9. The admin surface

All of these need `{{adminToken}}`. The filters on the list requests ship **unchecked** with a
working example inside, so the request runs as it is and turning a filter on is one checkbox.

| Request | Shows |
| --- | --- |
| Reports → 01. Dashboard figures | counts by status, category and ward, SLA breaches, today's numbers — all from `groupBy`, no N+1 |
| Users → 01. List users | `?role=OFFICER` filter; saves `officerId` and `targetUserId` |
| Users → 02. Create an officer | generated temp password, two-factor **on** |
| Users → 03. Block or unblock | the blocked user's next request is `403`, within one request, not fifteen minutes |
| Users → 05. Force logout everywhere | |
| Reports → 04. Audit trail | append-only; a Postgres trigger rejects any `UPDATE` or `DELETE` on this table |
| Super admin → 02. Security events | failed logins, OTP failures, token reuse, new devices |
| Reports → 02. Per-department SLA report | total, breached, breach %, average resolution, average rating |
| Reports → 03. Streamed CSV export | use **Send and Download** |
| Super admin → 03. Change a runtime setting | five keys only; anything else is a `400` |

Five endpoints are **super admin only** and answer `403` to an ordinary admin:
`POST /admin/admins`, `DELETE /admin/admins/:id`, `PATCH /admin/restore/:entity/:id`,
`GET /admin/security-events`, `PATCH /admin/settings/:key`. `isSuperAdmin` is not in any token and
cannot be set through any endpoint — only the seed sets it, and a database CHECK keeps it on ADMIN
rows.

---

## 10. Security behaviour you can demonstrate

| Try this | Expect |
| --- | --- |
| Any request with no `Authorization` | `401` in the same envelope as every other response |
| A citizen token on `GET /admin/users` | `403` |
| A citizen token on another citizen's complaint | `403 NOT_OWNER` |
| `GET /complaints/does-not-exist` | `404` |
| A body with an extra key | `400` with the offending field named |
| `POST /complaints` twice with the same key and body | `Idempotent-Replay: true`, no second complaint |
| Same key, edited body | `422 IDEMPOTENCY_MISMATCH` |
| Two status changes racing | one `200`, one `409` — optimistic lock via `updateMany` |
| Six failed logins from one IP | `429` from the auth limiter |
| An upload renamed `evil.exe` → `photo.jpg` | `400` — the magic bytes are inspected, not the extension |
| `<script>` in any text field | stored stripped by `sanitize-html` |
| `GET {{host}}/metrics` with a citizen token | `403` — Prometheus metrics are admin-only |

The per-IP auth limiter fires before the per-account lockout can be observed from a single IP, so
you will usually see `429` before `423 ACCOUNT_LOCKED`. Both controls exist; this interaction is
documented in the README and in [`docs/security-tests.md`](security-tests.md).

---

## 11. File uploads

Three requests take `multipart/form-data`. In Postman, Body → form-data, set the row type to
**File**, then pick a file. The text row next to it is already filled in.

| Request | File field | Accepts | Limit |
| --- | --- | --- | --- |
| 03 — User → 03. Upload an avatar | `avatar` | JPG, PNG, WebP | 5 MB |
| 05 — Complaint → Attachments → 01 | `file` (+ `kind`) | JPG, PNG, WebP | 5 MB, 5 per complaint |
| 06 — Service request → 05 | `document` (+ `label`) | PDF, JPG, PNG | 5 MB |

Every upload is checked twice: the declared MIME type and then the file's real magic bytes.
Service-request documents are private — the signed link expires in ten minutes, and only the owner
or staff may ask for one. All three need Cloudinary credentials; without them the upload is `503`.

---

## 12. When something does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED` | server not running | `pnpm run dev` |
| Everything `401` | no environment selected | pick **CityCare — local**, top right |
| `401` after working fine | the access token expired (15 minutes) | re-run folder 01 |
| `403` on an admin route | the request is sending `{{citizenToken}}` | re-run folder 01 — the folders already point at the right variable |
| `429` on everything | the global limiter, 100 per 15 min | set `RATE_LIMIT_GLOBAL_MAX=1000` in `.env` and restart |
| `429` on `/auth/*` only | five failed auth attempts per 15 min | set `RATE_LIMIT_AUTH_MAX=50`, or wait |
| `{{categoryId}}` appears literally in a body | folder 04 was never run | run the Master data list requests once |
| `201` but no new complaint | an idempotent replay | change `idempotencyKey` — the console says so too |
| `409 DUPLICATE_COMPLAINT` | an open complaint already exists for this citizen, category and ward | finish the lifecycle, or change `wardId` |
| `409 INVALID_TRANSITION` | wrong step or wrong role | check the table in §5 |
| `409` on `RESOLVED` | no resolution proof | upload an attachment with `kind: RESOLUTION_PROOF` first |
| `503` on payment or upload | SSLCommerz / Cloudinary keys missing | fill them in `.env` and restart |
| No OTP arrives | SMTP not configured | read it from the dev server log — `[dev only] … OTP for …` |
| A `⚠` request logged you out | that is what it does | re-run folder 01 |

---

## 13. Reading a response

Every endpoint answers in the same envelope — success, failure, 404, 429 and 500 alike.

```json
{ "success": true, "message": "Complaint submitted successfully", "data": { "…": "…" } }
```

```json
{ "success": false, "message": "Validation failed",
  "errors": [{ "field": "title", "code": "VALIDATION_ERROR", "message": "Too short" }],
  "requestId": "93f6759d-a47b-41db-99d8-0481b3ed77f6" }
```

`requestId` is on every failure and in every log line, so a report and a log entry can be matched
up. Outside production a `5xx` also carries `stack`; in production it never does.

Listings add `meta`:

```json
{ "success": true, "message": "Complaints retrieved", "data": [ … ],
  "meta": { "page": 1, "limit": 10, "total": 24, "totalPages": 3 } }
```

Pagination is `?page=&limit=&sortBy=&sortOrder=` on every list, with `sortBy` restricted to a
whitelist per module — an unknown column is rejected rather than passed through.
