# Testing CityCare in Postman

Everything in this guide runs against a local server with seeded data. Nothing here needs a
mailbox, a payment gateway account, or a Google project — where one of those *is* required, the
guide says so and tells you what the honest failure looks like.

- Collection: [`docs/api/citycare.postman_collection.json`](api/citycare.postman_collection.json) — 98 requests in 10 folders
- Environment: [`docs/api/citycare.postman_environment.json`](api/citycare.postman_environment.json)
- The same surface is browsable at `http://localhost:5000/api/v1/docs` (Swagger UI) and in
  [`docs/openapi.yaml`](openapi.yaml)

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

---

## 2. Import

1. Postman → **Import** → drop in both JSON files from `docs/api/`.
2. Top right, select the environment **CityCare — local**.
3. Open the eye icon next to it to watch variables fill in as you work.

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

## 4. Start here — four requests, in order

Folder **0 — Start here**.

| # | Request | Expect | What it does |
| --- | --- | --- | --- |
| 1 | Health | `200` | `{"success":true,"message":"OK","data":{"uptime":12.4}}`. `GET {{host}}/ready` also pings Postgres and Redis. |
| 2 | Log in as ADMIN | `200` | saves `adminToken` |
| 3 | Log in as OFFICER | `200` | saves `officerToken` |
| 4 | Log in as CITIZEN | `200` | saves `citizenToken`, `refreshToken`, `userId` |

Each login reads `data.user.role` from the response and writes the access token into the variable
that role needs, so you never copy a token by hand. Watch the Postman console (`Ctrl/Cmd + Alt + C`)
— it prints `saved adminToken for ADMIN` and every id it captures.

Then run these three once, in the **Master data** folder, to fill the reference ids:

| Request | Saves |
| --- | --- |
| `GET /categories` | `categoryId` — prefers **Pothole**, which belongs to Roads, the department `officer1` works in |
| `GET /wards` | `wardId` |
| `GET /service-types` | `serviceTypeId` |

`GET /admin/users` (Admin folder, admin token) saves `officerId` and `targetUserId`.

### Variables the scripts maintain

| Variable | Set by |
| --- | --- |
| `adminToken`, `officerToken`, `citizenToken` | any login, routed by the role in the response |
| `refreshToken`, `userId` | any login; refresh also rewrites `citizenToken` |
| `challengeId` | a `202` two-factor response |
| `otp` | **you type this in** — from the email, or the dev server log |
| `categoryId`, `wardId`, `zoneId`, `departmentId`, `serviceTypeId` | the master-data list requests |
| `complaintId`, `trackingId` | `POST /complaints` |
| `serviceRequestId`, `documentId` | `POST /service-requests`, document upload |
| `paymentId`, `transactionId` | `POST /payments/initiate` |
| `officerId`, `targetUserId` | `GET /admin/users` |
| `notificationId`, `sessionId` | the matching list requests |
| `idempotencyKey` | fixed at `demo-key-001`; change it to create a second complaint |

Path parameters are pre-filled from these, so `GET /complaints/:id` resolves to the complaint you
just created without editing anything.

---

## 5. Walkthrough A — a complaint from report to closed

This is the one to record for a demo. Ten requests, no manual copying, about two minutes.

| # | Request | Token | Body / note | Expect |
| --- | --- | --- | --- | --- |
| 1 | `POST /complaints` | citizen | as shipped (uses `{{categoryId}}`, `{{wardId}}`) | `201` — saves `complaintId` + `trackingId` |
| 2 | `GET /complaints/track/:trackingId` | **none** | public tracking | `200` — status, category, ward, timeline, no personal data |
| 3 | `PATCH /complaints/:id/status` | **admin** | `{"status":"UNDER_REVIEW","note":"Reviewing the report"}` | `200` |
| 4 | `POST /complaints/:id/assign` | **admin** | `{"officerId":"{{officerId}}","auto":false,"reason":"…"}` | `200` — status becomes `ASSIGNED` |
| 5 | `GET /complaints/my-assigned` | **officer** | — | `200` — the complaint is in the list |
| 6 | `PATCH /complaints/:id/status` | **officer** | `{"status":"IN_PROGRESS","note":"Crew dispatched"}` | `200` |
| 7 | `PATCH /complaints/:id/status` | **officer** | `{"status":"RESOLVED"}` | **`409`** — see below |
| 8 | `POST /complaints/:id/attachments` | **officer** | form-data: `file` = any JPG/PNG, `kind` = `RESOLUTION_PROOF` | `201` |
| 9 | `PATCH /complaints/:id/status` | **officer** | `{"status":"RESOLVED","note":"Pothole filled"}` | `200` |
| 10 | `POST /complaints/:id/feedback` | citizen | `{"rating":5,"comment":"…"}` | `201` — the rating closes the complaint |
| 11 | `GET /complaints/:id/history` | any | — | `200` — every hop with who made it and when |

**Step 7 is deliberate.** "Resolved" has to be provable: without at least one
`RESOLUTION_PROOF` attachment the transition is refused with
`{"code":"CONFLICT","message":"At least one RESOLUTION_PROOF attachment is required"}`. Step 8
supplies it. If Cloudinary is not configured, skip 7–9 and finish the walkthrough at step 6.

### The state machine, in full

`PATCH /complaints/:id/status` is one endpoint, but who may move where is fixed:

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
| `POST /complaints/:id/upvote` | citizen | `201`; one vote per person, and at ten votes the priority moves up a step |
| `POST /complaints/:id/comments` with `"isInternal": true` | officer | staff-only note — fetch the comments as the citizen and it is not there |
| `GET /complaints/search?q=gorto` | any | trigram search over title and description |
| `GET /complaints/nearby?lat=23.8069&lng=90.3687&radiusKm=2` | any | real Haversine distance, sorted nearest first |
| `POST /complaints` twice with the same title inside 100 m | citizen | the response carries a possible-duplicate hint |

---

## 6. Walkthrough B — signup and two-factor, without a mailbox

`POST /auth/register` writes **nothing** to PostgreSQL. The pending account lives in Redis for ten
minutes with the password bcrypt-hashed and the OTP HMAC-hashed; the row is created only when the
OTP is verified.

1. `POST /auth/register` — a pre-request script puts a fresh address in `{{signupEmail}}`, so this
   never collides. → `202 { email: "c****e@example.com", expiresInSec: 600 }`
2. **Get the OTP.** With SMTP configured it is in the inbox. Without it, the dev server prints it:

   ```
   WARN: [dev only] signup OTP for citycare.1758…@example.com: 418902
   ```

   Paste the six digits into the `otp` environment variable.
3. `POST /auth/verify-otp` → `201` with tokens, and now the user exists.

Two-factor on login works the same way: log in as `citizen2@citycare.com` and you get
`202 { twoFactorRequired: true, challengeId }`. The script saves `challengeId`; put the OTP in
`otp` and send `POST /auth/login/verify-otp`. Set `"trustDevice": true` and the response includes a
`deviceToken` that skips the OTP next time — citizens only.

### Things to check in this folder

| Request | Expect | Why it matters |
| --- | --- | --- |
| `POST /auth/register` with an email that exists | `409 EMAIL_EXISTS` | |
| `POST /auth/register` with `"role": "ADMIN"` added | `400` | every body is `.strict()`; no privilege field is ever accepted |
| `POST /auth/login` with a wrong password | `401 Invalid credentials` | an unknown email gives the identical answer, in the same time — a dummy bcrypt compare runs either way |
| `POST /auth/forgot-password` with an unknown email | `200` | no account-existence oracle |
| `GET /auth/sessions` | `200` | every device, with ip and user agent |
| `POST /auth/logout` then any authed request | `401` | the token's `jti` is on a Redis denylist until it expires |
| `POST /auth/refresh-token` twice with the same token | `401` + every session revoked | rotation with reuse detection |
| `PATCH /auth/2fa {"enabled": false}` as admin | `403 FORBIDDEN_ROLE` | staff cannot drop to one factor |

---

## 7. Walkthrough C — service request, payment, refund

| # | Request | Token | Expect |
| --- | --- | --- | --- |
| 1 | `POST /service-requests` | citizen | `201`, status `PENDING_PAYMENT`, saves `serviceRequestId` |
| 2 | `POST /service-requests/:id/documents` | citizen | `201` — form-data `document` = a PDF, `label` = text |
| 3 | `POST /payments/initiate` | citizen | `201` with `paymentUrl` — **or `503` if the gateway is not configured** |
| 4 | *(browser)* open `paymentUrl`, pay with the sandbox card | — | SSLCommerz redirects to `/payments/success` |
| 5 | `GET /payments/my` | citizen | `200` — status `SUCCESS` |
| 6 | `PATCH /service-requests/:id/status` | officer | `{"status":"PROCESSING"}` → `200` |
| 7 | `PATCH /service-requests/:id/status` | officer | `{"status":"COMPLETED"}` → `200` |
| 8 | `POST /payments/:id/refund` | admin | `201` — refund requested |
| 9 | `PATCH /payments/:id/refund/approve` | **super admin** | `200` — a different person must approve |

**Without SSLCommerz credentials**, step 3 answers:

```json
{ "success": false, "message": "Payment gateway is not configured",
  "errors": [{ "code": "SERVICE_UNAVAILABLE", "message": "SSLCommerz credentials are missing" }],
  "requestId": "93f6759d-a47b-41db-99d8-0481b3ed77f6" }
```

That is the correct answer, not a bug — set `SSL_STORE_ID` and `SSL_STORE_PASSWORD` in `.env` and
restart. Service-request steps 1, 2, 6 and 7 still need a paid request, so without the gateway the
status transitions stop at `PENDING_PAYMENT` (`409 INVALID_TRANSITION`, which is also correct:
processing only starts once the money is in).

The amount is **never** read from the request body — it comes from `ServiceType.fee` in the
database. The success callback and the IPN both call one idempotent `confirm(tranId, valId)`, so a
replayed callback cannot pay twice. See [`docs/payment-flow.md`](payment-flow.md).

---

## 8. Walkthrough D — the admin surface

All of these need `{{adminToken}}`.

| Request | Shows |
| --- | --- |
| `GET /admin/dashboard-stats` | counts by status, by category, SLA breaches, today's numbers — all from `groupBy`, no N+1 |
| `GET /admin/users?role=OFFICER` | filtered listing; saves `officerId` |
| `POST /admin/officers` | creates an officer with a generated temp password, two-factor **on** |
| `PATCH /admin/users/:id/status` | `BLOCKED` — the blocked user's next request is `403`, within one request, not fifteen minutes |
| `DELETE /admin/users/:id/sessions` | force logout everywhere |
| `GET /admin/audit-logs` | append-only; a Postgres trigger rejects any `UPDATE` or `DELETE` on this table |
| `GET /admin/security-events` | super admin only — failed logins, OTP failures, token reuse, new devices |
| `GET /admin/reports/sla` | per-department SLA performance |
| `GET /admin/reports/complaints.csv` | streamed CSV; **Send and Download** in Postman |
| `PATCH /admin/settings/REOPEN_LIMIT` | runtime knobs, super admin only, no deploy needed |

Five endpoints are **super admin only** and answer `403` to an ordinary admin:
`POST /admin/admins`, `DELETE /admin/admins/:id`, `PATCH /admin/restore/:entity/:id`,
`GET /admin/security-events`, `PATCH /admin/settings/:key`. `isSuperAdmin` is not in any token and
cannot be set through any endpoint — only the seed sets it, and a database CHECK keeps it on ADMIN
rows.

---

## 9. Security behaviour you can demonstrate

| Try this | Expect |
| --- | --- |
| Any request with no `Authorization` | `401` in the same envelope as every other response |
| A citizen token on `GET /admin/users` | `403` |
| A citizen token on another citizen's complaint | `403 NOT_OWNER` |
| `GET /complaints/does-not-exist` | `404` |
| A body with an extra key | `400` with the offending field named |
| Send `POST /complaints` twice with the same `Idempotency-Key` and body | second response carries `Idempotent-Replay: true` and is byte-identical — no second complaint |
| Same key, edited body | `422 IDEMPOTENCY_MISMATCH` |
| Two `PATCH /complaints/:id/status` calls racing | one `200`, one `409` — optimistic lock via `updateMany` |
| `POST /auth/login` six times with a wrong password | `429` from the auth limiter (5 per 15 min per IP) |
| An upload renamed `evil.exe` → `photo.jpg` | `400` — the magic bytes are inspected, not the extension |
| `<script>` in any text field | stored stripped by `sanitize-html` |
| `GET /metrics` with a citizen token | `403` — Prometheus metrics are admin-only |

The per-IP auth limiter fires before the per-account lockout can be observed from a single IP, so
you will usually see `429` before `423 ACCOUNT_LOCKED`. Both controls exist; this interaction is
documented in the README and in [`docs/security-tests.md`](security-tests.md).

---

## 10. File uploads

Three endpoints take `multipart/form-data`. In Postman, Body → form-data, set the row type to
**File**, then pick a file.

| Endpoint | Field | Accepts | Limit |
| --- | --- | --- | --- |
| `PATCH /users/me/avatar` | `avatar` | JPG, PNG, WebP | 5 MB |
| `POST /complaints/:id/attachments` | `file` (+ `kind` text) | JPG, PNG, WebP | 5 MB, 5 per complaint |
| `POST /service-requests/:id/documents` | `document` (+ `label` text) | PDF, JPG, PNG | 5 MB |

Every upload is checked twice: the declared MIME type and then the file's real magic bytes.
Service-request documents are private — `GET /service-requests/:id/documents/:docId` returns a
signed URL that expires in ten minutes, and only the owner or staff may ask for one.

All three need Cloudinary credentials. Without them the upload answers `503`.

---

## 11. Folder reference

| Folder | Requests | Notes |
| --- | --- | --- |
| 0 — Start here | 4 | health + the three logins |
| Auth | 18 | register, OTP, login, 2FA, sessions, refresh, Google, password reset |
| User | 5 | profile, avatar, delete, GDPR-style export |
| Master data | 16 | departments, categories, wards, zones, service types — lists are public and Redis-cached |
| Complaint | 20 | the full lifecycle |
| Service request | 7 | apply, documents, processing |
| Payment | 9 | initiate, four gateway callbacks, refund flow |
| Notification | 3 | list, mark one read, mark all read |
| Admin | 15 | users, reports, audit, settings |
| Officer | 1 | `GET /officer/stats` |

Outside `/api/v1` and therefore outside `{{baseUrl}}`: `GET {{host}}/health`,
`GET {{host}}/ready`, `GET {{host}}/metrics` (admin token), `GET {{host}}/`.

---

## 12. When something does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED` | server not running | `pnpm run dev` |
| Everything `401` | no environment selected | pick **CityCare — local**, top right |
| `401` after working fine | the access token expired (15 minutes) | run the matching login again, or `POST /auth/refresh-token` |
| `403` on an admin route | the request is sending `{{citizenToken}}` | re-run "Log in as ADMIN"; the folders already point at the right variable |
| `{{categoryId}}` appears literally in the body | the master-data lists were never run | run `GET /categories` and `GET /wards` once |
| `409 INVALID_TRANSITION` | wrong step or wrong role | check the state-machine table in §5 |
| `409` on `RESOLVED` | no resolution proof | upload an attachment with `kind: RESOLUTION_PROOF` first |
| `409 CONFLICT` on assign | the officer is in a different department than the category | use `{"auto": true}`, which picks the least-loaded officer in the right department |
| `429` everywhere on `/auth/*` | the auth limiter | wait 15 minutes, or restart Redis to clear the counters |
| `503` on payment or upload | SSLCommerz / Cloudinary keys missing | fill them in `.env` and restart |
| No OTP arrives | SMTP not configured | read it from the dev server log — `[dev only] … OTP for …` |
| `Idempotent-Replay: true` when you wanted a new complaint | the key is reused | change `idempotencyKey` in the environment |

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
