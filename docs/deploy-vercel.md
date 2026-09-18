# Deploying CityCare to Vercel — implementation brief

Written for whoever (or whatever) is doing the work. Everything below is specific to this
repository; the facts in "Ground truth" were checked against the code, so trust them over
assumptions.

For a platform that runs this project unchanged, see [`docs/runbook.md`](runbook.md) — Render or any
other long-running Node host needs no code changes at all. Vercel does, and this brief is that work.

---

## Ground truth about this codebase

| Fact | Value |
| --- | --- |
| Module system | ESM (`"type": "module"`), `.js` extensions on every relative import |
| Path alias | `@/*` → `./src/*`, rewritten to real relative paths at build time by `tsc-alias` |
| Build | `pnpm run build` = `prisma generate && tsc && tsc-alias -p tsconfig.json --resolve-full-paths` → `dist/` |
| Express app | `src/app.ts` **default-exports the app and never calls `listen`** — this is what the function will use |
| Server entry | `src/server.ts` calls `listen`, `startJobs()` and installs signal handlers — **serverless must not import it** |
| tsconfig | `include: ["src"]`, `rootDir: ./src`, `outDir: ./dist` — `api/` is deliberately outside it |
| Cron jobs | `src/jobs/index.ts` uses `node-cron`; the work itself is `runSlaCheck()` and `runPurge()`, both exported |
| Prisma | v7, `prisma-client` generator, output `src/generated/prisma`, driver adapter `@prisma/adapter-pg` |
| Redis | `ioredis`, `lazyConnect: true` **and** `enableOfflineQueue: false` — a command issued before the socket is up throws |
| Env | `src/config/env.ts` is the **only** file allowed to read `process.env`. Keep it that way. |
| Top-level await | `src/routes/index.ts` line 39: `await mountSwagger(router)` |

---

## What Vercel changes, and what to do about it

| Breaks | Why | Fix in this brief |
| --- | --- | --- |
| `node-cron` | no long-lived process; nothing is alive between requests | Step 3 — HTTP endpoints + `vercel.json` `crons` |
| In-memory rate limiter | each invocation may be a fresh instance, so counters never accumulate | Step 5 — Redis store (recommended, not strictly required) |
| Graceful shutdown | there is nothing to shut down | nothing — leave `server.ts` alone, it simply is not used |
| Redis first command | `lazyConnect` + `enableOfflineQueue: false` | Step 1 — `await connectRedis()` once per warm instance |

### Limits you cannot engineer around on the Hobby plan

State these to the user before starting; they change what the deployment can honestly claim.

- **Cron runs once per day, and at most two jobs.** The SLA escalation is written to run hourly. On
  Hobby it can only run daily. Say so in the README rather than pretending otherwise.
- **Request body limit is 4.5 MB.** The app accepts 5 MB uploads. Uploads between 4.5 and 5 MB will
  fail at the platform edge, before Express sees them.
- **`maxDuration` is 60 s at most.** The streamed CSV export is the only endpoint likely to care.
- **Cold starts.** The first request after idle pays Prisma and Redis connection setup.

---

## Step 1 — the serverless entry

Create **`api/index.ts`** exactly as below. It imports the *built* app from `dist/`, not from
`src/`, which is what keeps the `@/*` alias and the ESM extensions working without teaching Vercel
about them.

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../dist/app.js";
import { connectRedis } from "../dist/config/redis.js";

/**
 * The Express app is a plain request listener, so Vercel can hand its own
 * req/res straight to it.
 *
 * Redis is built with `lazyConnect` and `enableOfflineQueue: false`, so the
 * first command on a cold instance would throw before the socket is up. One
 * connect per warm instance fixes that; the promise is cached, never awaited
 * twice, and never torn down — there is no shutdown in a serverless runtime.
 */
let ready: Promise<unknown> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
	ready ??= connectRedis();
	await ready;
	(app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
```

Do **not** import `../dist/server.js` — it calls `listen` and starts cron.

---

## Step 2 — `vercel.json`

Create it at the repository root.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm run build",
  "functions": {
    "api/index.ts": {
      "maxDuration": 60,
      "includeFiles": "dist/**"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }],
  "crons": [
    { "path": "/internal/jobs/sla", "schedule": "0 3 * * *" },
    { "path": "/internal/jobs/purge", "schedule": "15 3 * * *" }
  ]
}
```

The rewrite is what makes `/health`, `/api/v1/...` and `/internal/...` all reach the one function.
`includeFiles` is there because `dist/` is produced by the build, not traced from imports.

---

## Step 3 — cron over HTTP

`vercel.json` `crons` calls a URL on a schedule; it cannot run `node-cron`. Add two endpoints next
to `/metrics` in **`src/app.ts`** — that file already holds the operational routes that sit outside
`/api/v1`, so they belong there rather than in a domain module.

Vercel sends a **GET** and, when `CRON_SECRET` is set in the project, an
`Authorization: Bearer <CRON_SECRET>` header. Accept POST too so the endpoints can be triggered by
hand.

Add the imports `runPurge`, `runSlaCheck` from `@/jobs/index.js`, `safeEqual` from
`@/utils/crypto.js`, `ApiError`, `catchAsync`, and then:

```ts
// --- scheduled jobs -------------------------------------------------------
// node-cron needs a process that stays alive. On a serverless host the
// platform's scheduler calls these instead, so the work itself is unchanged —
// `runSlaCheck` and `runPurge` are the very functions the cron entries call.
const runJob = (job: "sla" | "purge") =>
	catchAsync(async (req: Request, res: Response) => {
		const provided = (req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (!env.CRON_SECRET || !safeEqual(provided, env.CRON_SECRET)) {
			throw new ApiError(401, "Unauthorized", [
				{ code: "UNAUTHORIZED", message: "Invalid cron secret" },
			]);
		}

		const data = job === "sla" ? await runSlaCheck() : await runPurge();
		logger.info({ job, data }, "scheduled job finished");
		sendResponse(res, { message: `${job} job finished`, data });
	});

for (const method of ["get", "post"] as const) {
	app[method]("/internal/jobs/sla", runJob("sla"));
	app[method]("/internal/jobs/purge", runJob("purge"));
}
```

Place these **above** `app.use(notFound)`.

`safeEqual` returns false on a length mismatch, so an empty or wrong header is rejected without a
timing signal. An unset `CRON_SECRET` rejects everything, which is the right default.

---

## Step 4 — `CRON_SECRET` in the env schema

`src/config/env.ts` is the only file permitted to read `process.env`. Add the key there, nowhere
else:

```ts
	// --- scheduled jobs ------------------------------------------------------
	// Set on the hosting platform; the scheduler sends it as a bearer token.
	// Empty means the job endpoints refuse everything, which is the safe default.
	CRON_SECRET: z.string().default(""),
```

Add it to `.env.example` too, with an empty value and a one-line comment.

---

## Step 5 — Redis-backed rate limiting (recommended)

The in-memory store in `src/middlewares/rateLimiter.ts` counts per instance. Serverless gives you
many short-lived instances, so the limiter effectively stops working. The README already lists the
per-instance store as a known limitation; on Vercel it becomes a real gap rather than a small one.

```bash
pnpm add rate-limit-redis
```

In `src/middlewares/rateLimiter.ts`, inside `base()`:

```ts
import { RedisStore } from "rate-limit-redis";
import { redis } from "@/config/redis.js";

// A shared store, because a per-instance counter means no limit at all when the
// platform runs many short-lived instances.
store: new RedisStore({
	sendCommand: (...args: string[]) => redis.call(...args) as Promise<never>,
	prefix: "rl:",
}),
```

Keep the existing comment honest: update it to say the store is Redis when configured.

If you skip this step, change the README's "Known limitations" entry to say the limiter does not
work on serverless. Do not leave the claim standing untested.

---

## Step 6 — `.vercelignore`

```
tests
docs
coverage
.github
.husky
```

`prisma/` must **not** be ignored: `prisma generate` runs during the build and needs the schema.

---

## Step 7 — project settings and environment

In the Vercel dashboard, **Settings → Environment Variables**, scope every one to *Production*
(and *Preview* if you want preview deployments to work).

Copy these unchanged from the developer's local `.env`:

```
DATABASE_URL  JWT_ACCESS_SECRET  JWT_REFRESH_SECRET  OTP_SECRET
JWT_ACCESS_EXPIRES_IN  JWT_REFRESH_EXPIRES_IN  BCRYPT_SALT_ROUNDS
REDIS_HOST  REDIS_PORT  REDIS_USERNAME  REDIS_PASSWORD
SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS  EMAIL_FROM
CLOUDINARY_CLOUD_NAME  CLOUDINARY_API_KEY  CLOUDINARY_API_SECRET
SSL_STORE_ID  SSL_STORE_PASSWORD  SSL_IS_LIVE
ADMIN_EMAIL  ADMIN_PASSWORD  SUPER_ADMIN_EMAIL
```

Set these to new values:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `BACKEND_URL` | the deployment URL, e.g. `https://citycare-api.vercel.app` |
| `CLIENT_URL` | the same URL, unless a frontend exists |
| `GOOGLE_CALLBACK_URL` | `<deployment>/api/v1/auth/google/callback` |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `RATE_LIMIT_GLOBAL_MAX` | `100` |
| `RATE_LIMIT_AUTH_MAX` | `5` |

Do **not** set: `PORT` (the platform owns it) or `TEST_DATABASE_URL`.

`BACKEND_URL` is load-bearing: the four SSLCommerz callback URLs and the magic sign-in link are all
built from it. A stale value means payments never come back and the emailed link 404s.

### Migrations

Vercel does not run them. From a machine with the production `DATABASE_URL` in its environment:

```bash
pnpm exec prisma migrate deploy
pnpm run db:seed          # only if the database is empty
```

---

## Step 8 — acceptance criteria

The deployment is not done until all of these pass against the live URL.

```bash
BASE=https://citycare-api.vercel.app

curl -s $BASE/health                       # 200, {"success":true,...,"uptime":…}
curl -s $BASE/ready                        # 200, data.db true and data.redis true
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/v1/docs        # 200 (Swagger UI)
curl -s $BASE/api/v1/categories | head -c 120                     # 200, the seeded categories

# login, which proves Postgres writes and JWT signing both work
curl -s -X POST $BASE/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@citycare.com","password":"Admin@12345"}' | head -c 160

# the cron endpoints: unauthorised, then authorised
curl -s -o /dev/null -w '%{http_code}\n' $BASE/internal/jobs/sla                  # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" $BASE/internal/jobs/sla           # 200 + counts
```

Then in Postman: change `host` and `baseUrl` to the deployment and run folder **01 — Setup**. All
five requests must pass. Folder **04 — Master data** and **05 — Complaint** should behave exactly as
[`docs/postman-guide.md`](postman-guide.md) describes.

Finally, in the Vercel dashboard, check **Cron Jobs** lists both entries and shows a next run.

---

## Do not change

- `src/server.ts` — it stays the entry point for every non-serverless host, and `pnpm run dev` and
  `pnpm start` must keep working locally and on Render.
- `src/jobs/index.ts` — `startJobs()` is still correct for a long-running process. The HTTP
  endpoints call the same `runSlaCheck` / `runPurge`, so there is one implementation, two triggers.
- Anything reading `process.env` outside `src/config/env.ts`. There is exactly one such file and it
  should stay that way.
- The response envelope, the error handler, or any existing route path.

Run `pnpm run lint`, `pnpm run typecheck` and `pnpm test` before committing. All three pass on
`main` today; they must still pass.

---

## Known failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails on `await mountSwagger` | top-level await survived into the bundle and the output format is not ESM | confirm `"type": "module"` is in `package.json`; if it still fails, make the swagger mount lazy — call it from the first request instead of at module scope |
| `Cannot find module '../dist/app.js'` | `buildCommand` did not run, or `includeFiles` is missing | check the build log for `tsc`; keep `"includeFiles": "dist/**"` |
| `Cannot find module '.prisma/client'` or a missing `.wasm` | the generated client was not traced into the bundle | widen `includeFiles` to `"{dist,node_modules/.prisma,node_modules/@prisma}/**"` |
| `Stream isn't writeable` | a Redis command ran before `connectRedis()` | the `ready ??=` line in Step 1 is missing or the handler does not await it |
| Every path 404s | the rewrite is missing or malformed | `"rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]` |
| `FUNCTION_INVOCATION_TIMEOUT` on the CSV export | default duration is too short | `maxDuration` in `vercel.json`, up to 60 on Hobby |
| Payment callbacks never arrive | `BACKEND_URL` still points at localhost | fix the env var and redeploy |
| Cron never fires | `CRON_SECRET` unset, or the Hobby plan's daily limit | check the Cron Jobs tab; Hobby allows two jobs, once a day |

---

## After it works

Update these to match reality rather than leaving them describing the old deployment:

- `README.md` → Deployment section, and the Known limitations entry about cron frequency and the
  rate limiter.
- `CHANGELOG.md` → a line under Added.
- `docs/runbook.md` → how to trigger a job by hand on this host.
