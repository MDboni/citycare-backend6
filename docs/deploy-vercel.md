# Deploying CityCare to Vercel

The code side is done. This repository builds and runs on Vercel as it stands — `vercel.json`,
`.vercelignore` and `api/index.ts` are committed, the cron runs over HTTP, and the rate limiter
counts in Redis. What is left is the part only you can do: paste the environment variables, run
the migration, and check the result.

For a long-running host — Render, Railway, a VPS — none of this applies. `src/server.ts` is still
the entry point there and nothing in this document is needed; see the Deployment section of
[`../README.md`](../README.md).

---

## What is already in the repository

| File | Does |
| --- | --- |
| `api/index.ts` | The serverless entry. Imports the **built** app from `dist/`, connects Redis once per warm instance, hands the request to Express. It never imports `src/server.ts`, which would call `listen()` and start `node-cron`. |
| `vercel.json` | Build and install commands, a rewrite sending every path to the one function, `maxDuration: 60`, `includeFiles` for `dist/` and `docs/`, and the two cron entries. |
| `.vercelignore` | Keeps `.env` out of a CLI deploy — the Vercel CLI does not read `.gitignore`. Keeps `docs/` and `prisma/` **in**; the first is read at runtime, the second during the build. |
| `/internal/jobs/sla`, `/internal/jobs/purge` in `src/app.ts` | The cron, as HTTP. Same `runSlaCheck` / `runPurge` the in-process scheduler calls. Bearer `CRON_SECRET`, compared in constant time. |
| `ResilientStore` in `src/middlewares/rateLimiter.ts` | Rate limit counters in Redis, shared across instances, falling back to per-instance memory if Redis is unreachable. |

`src/server.ts` and `src/jobs/index.ts` are untouched, so `pnpm run dev`, `pnpm start` and a Render
deploy all behave exactly as before.

---

## What Vercel takes away

State these plainly rather than discovering them during a demo.

| Limit | Consequence |
| --- | --- |
| **Cron: 2 jobs, once a day** (Hobby) | The SLA escalation is designed to run hourly. Here it runs daily at 03:00 UTC. A complaint breaching its SLA at 03:05 is escalated the next morning, not within the hour. |
| **Request body ≤ 4.5 MB** | Uploads are capped at 4 MB, deliberately under the line, so every rejection is this API's own `413` rather than an opaque platform error. |
| **`maxDuration` ≤ 60 s** | Only the streamed admin CSV export is likely to care. |
| **Cold starts** | The first request after idle pays for the Prisma and Redis connection. `/health` is the cheapest thing to warm it with. |
| **No shared process** | Anything in memory dies with the instance. That is why the limiter uses Redis. |

If the hourly SLA check matters more than the platform, deploy to Render instead — it runs this
project unchanged, and cron stays hourly.

---

## Step 1 — import the repository

Vercel dashboard → **Add New → Project** → pick the GitHub repo → **Import**.

Leave the framework preset as **Other**. `vercel.json` already sets the install and build commands,
so do not override them in the UI. Vercel reads `pnpm-lock.yaml` and uses pnpm on its own.

Do not deploy yet — set the environment variables first, or the first build will fail on the Zod
check in `src/config/env.ts`, which is exactly what it is there for.

---

## Step 2 — environment variables

**Settings → Environment Variables.** Scope every one to **Production** (add **Preview** too if you
want preview deployments to work).

Copy these unchanged from your local `.env`:

```
DATABASE_URL
JWT_ACCESS_SECRET  JWT_REFRESH_SECRET  OTP_SECRET
JWT_ACCESS_EXPIRES_IN  JWT_REFRESH_EXPIRES_IN  BCRYPT_SALT_ROUNDS
REDIS_URL  (or REDIS_HOST REDIS_PORT REDIS_USERNAME REDIS_PASSWORD)
SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS  EMAIL_FROM
CLOUDINARY_CLOUD_NAME  CLOUDINARY_API_KEY  CLOUDINARY_API_SECRET
SSL_STORE_ID  SSL_STORE_PASSWORD  SSL_IS_LIVE
GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET
ADMIN_EMAIL  ADMIN_PASSWORD  SUPER_ADMIN_EMAIL
```

Set these to new values:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `CRON_SECRET` | a fresh random string — `openssl rand -hex 32` |
| `RATE_LIMIT_GLOBAL_MAX` | `100`, or `1000` while an evaluator is clicking through Postman |
| `RATE_LIMIT_AUTH_MAX` | `5`, or `50` for the same reason |
| `BACKEND_URL` | the deployment URL — **you do not know it yet**, see Step 4 |
| `CLIENT_URL` | the same URL, unless a frontend exists |
| `GOOGLE_CALLBACK_URL` | `<deployment>/api/v1/auth/google/callback` |

Do **not** set `PORT` — the platform owns it — or `TEST_DATABASE_URL`, which points at a database
the integration tests truncate.

`BACKEND_URL` is load-bearing: the four SSLCommerz callback URLs and the emailed magic sign-in link
are all built from it at request time. A stale value means payments never come back and the link in
the email 404s.

---

## Step 3 — the database

Vercel does not run migrations. From your own machine, with the **production** `DATABASE_URL` in the
environment:

```bash
pnpm exec prisma migrate deploy
pnpm run db:seed          # only if the database is empty
```

The seed is idempotent, so running it twice is safe — but it only creates rows, it never repairs
edited ones.

---

## Step 4 — deploy, then fix the URL

1. **Deploy.** Vercel assigns a URL, e.g. `https://citycare-backend.vercel.app`.
2. Go back to **Environment Variables** and set `BACKEND_URL`, `CLIENT_URL` and
   `GOOGLE_CALLBACK_URL` to that URL.
3. **Redeploy** — environment variables are read at boot, so an edit alone changes nothing.
4. In the Google Cloud console, add `<deployment>/api/v1/auth/google/callback` to the OAuth client's
   authorised redirect URIs. Google rejects anything not listed there, whatever the app sends.

---

## Step 5 — verify

Not deployed until all of these pass.

```bash
BASE=https://citycare-backend.vercel.app

curl -s $BASE/health                       # 200, {"success":true,...,"uptime":…}
curl -s $BASE/ready                        # 200, data.db true and data.redis true
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/v1/docs     # 200 — Swagger UI
curl -s $BASE/api/v1/categories | head -c 120                  # 200, the seeded categories

# login: proves Postgres reads, bcrypt and JWT signing all work
curl -s -X POST $BASE/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@citycare.com","password":"Admin@12345"}' | head -c 160

# the job endpoints: refused, then accepted
curl -s -o /dev/null -w '%{http_code}\n' $BASE/internal/jobs/sla                # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" $BASE/internal/jobs/sla         # 200 + counts
```

`data.redis: true` in `/ready` is the one to read twice. If it is `false`, the rate limiter is
running on per-instance counters — which on a serverless host means no real limit at all.

Then in Postman: point `host` and `baseUrl` at the deployment and run folder **01 — Setup**. All
five requests must pass. Folders **04 — Master data** and **05 — Complaint** should behave exactly
as [`postman-guide.md`](postman-guide.md) describes.

Finally, **Settings → Cron Jobs** must list both entries with a next run time.

---

## When something breaks

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails on the env check | a required variable is missing | the log names it — `src/config/env.ts` prints every failing key |
| `Cannot find module '../dist/app.js'` | the build command did not run, or `includeFiles` was edited | check the build log for `tsc`; keep `"includeFiles": "{dist,docs}/**"` |
| `Cannot find module '.prisma/client'`, or a missing `.wasm` | the generated client was not traced into the bundle | widen `includeFiles` to `"{dist,docs,node_modules/.prisma,node_modules/@prisma}/**"` |
| `/api/v1/docs` 404s | `docs/openapi.yaml` was not uploaded | it must not be in `.vercelignore`, and `includeFiles` must cover `docs/` |
| `Stream isn't writeable` | a Redis command ran before the socket was up | the `ready ??= connectRedis()` line in `api/index.ts` is missing or not awaited |
| Every path 404s | the rewrite is gone or malformed | `"rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]` |
| `FUNCTION_INVOCATION_TIMEOUT` on the CSV export | the default duration is too short | `maxDuration` in `vercel.json`, up to 60 on Hobby |
| Payment callbacks never arrive | `BACKEND_URL` still points at localhost | fix it and **redeploy** |
| The magic sign-in link 404s | same cause | same fix |
| Cron never fires | `CRON_SECRET` unset, or the Hobby daily limit | check the Cron Jobs tab; the endpoint answers 401 without the secret |
| `429` everywhere during a demo | the global budget is 100 calls / 15 min per IP | raise `RATE_LIMIT_GLOBAL_MAX` and redeploy |

A 500 with no detail: **Deployments → the deployment → Runtime Logs**. Every response carries a
`requestId`, and the same id is on every log line for that request — search the log for it.

---

## What still differs from a long-running host

| | Render | Vercel |
| --- | --- | --- |
| Entry | `src/server.ts` | `api/index.ts` |
| SLA escalation | hourly, `node-cron` | daily 03:00 UTC, platform scheduler |
| Retention purge | daily 03:15 UTC, `node-cron` | daily 03:15 UTC, platform scheduler |
| Rate limit counters | Redis, one instance | Redis, many instances — which is why Redis is required rather than nice to have |
| Graceful shutdown | drains connections on SIGTERM | nothing to drain |
| Upload ceiling | 4 MB (app) | 4 MB (app), 4.5 MB (platform) |
