# Incident runbook

What to do in the first fifteen minutes. Record every incident in
`docs/incidents/YYYY-MM-DD.md`: what happened, the cause, the fix, and what stops it recurring.

## Secret leaked

1. Rotate **every** secret: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_SECRET`,
   `DATABASE_URL` credentials, SSLCommerz store password, Cloudinary API secret, SMTP password.
2. Rotating the JWT secrets invalidates every access token immediately. Also run a bulk session
   revoke so refresh tokens die too.
3. Purge the secret from git history (`git filter-repo`), then force-push and tell every
   collaborator to re-clone.
4. Review `SecurityEvent` and `AuditLog` for the window between leak and rotation.

## Admin account compromised

1. A super admin blocks the account: `PATCH /admin/users/:id/status { "status": "BLOCKED" }` —
   this revokes all of its sessions in the same call.
2. `DELETE /admin/users/:id/sessions` for a belt-and-braces force logout.
3. Read `GET /admin/audit-logs?actorId=…` for everything that account did.
4. Force a password reset before unblocking.

## Brute force

1. `GET /admin/security-events?type=LOGIN_FAILED&ip=…` to see the shape of it.
2. Tighten `authLimiter` in `src/middlewares/rateLimiter.ts` and redeploy if needed.
3. Block the IP at the edge (Render, Cloudflare) — that is cheaper than blocking it in Node.
4. Individual accounts lock themselves after 5 failures (15 min) and 10 (1 h); no action needed
   per account.

## Payment mismatch

1. Find the raw truth: `SELECT * FROM "PaymentEvent" WHERE "transactionId" = '…' ORDER BY "createdAt"`.
2. Compare it against the `Payment` row and against the SSLCommerz merchant panel.
3. If the gateway took money the app never confirmed, re-run `confirm(tranId, valId)` — it is
   idempotent and will do nothing if the payment is already SUCCESS.
4. If money was taken in error, refund: admin requests, super admin approves.

## Database down

1. `/ready` returns 503 while `/health` still returns 200 — that is the intended split.
2. **Do not restart the API.** It reconnects on its own; a restart only adds cold starts.
3. Check the provider status page (Neon/Supabase) and the connection limit.
4. Keep serving 503 until the database is back. Redis being down does *not* cause this.

## Bad deploy

1. Roll back to the previous deploy in the host's dashboard.
2. Never roll a migration backwards. Write a new forward migration that fixes the problem.
3. If the bad deploy already ran a destructive migration, restore from the point-in-time backup
   and replay.

## Backup and recovery

| Topic | Plan |
| --- | --- |
| Database | Provider point-in-time restore (7 days) plus a weekly `pg_dump` to separate encrypted storage |
| RPO / RTO | Data loss ≤ 1 h, restore ≤ 2 h |
| Redis | Disposable. It holds cache, OTPs and counters; users simply request a new OTP |
| Cloudinary | Soft-delete assets; `publicId` is stored in the database, so links can be rebuilt |
| Migrations | Forward-only; destructive changes in two releases (add → backfill → drop) |

## Health endpoints

| Path | Means |
| --- | --- |
| `/health` | The process is alive. Use it for uptime monitoring |
| `/ready` | Postgres answered and Redis status is reported. 503 if the database is unreachable. Use it as the platform health check |
| `/metrics` | Prometheus metrics; needs an ADMIN token |

## Running a scheduled job by hand

The SLA escalation and the retention purge normally run from `node-cron` inside the process.
They are also reachable over HTTP, which is how a serverless host's scheduler calls them — and
how you run one now without waiting for the next tick.

```bash
BASE=https://your-deployment
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/internal/jobs/sla"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE/internal/jobs/purge"
```

Each answers with what it did, so the response is the audit trail:

```json
{ "success": true, "message": "sla job finished", "data": { "escalated": 3, "autoClosed": 1 } }
```

The secret is compared in constant time and an unset `CRON_SECRET` refuses everyone, so on a
host that runs the cron in-process you can simply leave it empty and the endpoints stay shut.

**The purge deletes and anonymises.** Read `src/jobs/purge.ts` before running it against
production out of schedule; it is idempotent, but it is not reversible.
