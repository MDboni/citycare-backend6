# Database

PostgreSQL via Prisma 7. The schema is split across nine files in `prisma/schema/`, which Prisma
merges into one model set.

| File | Models |
| --- | --- |
| `schema.prisma` | generator + datasource |
| `enums.prisma` | all 11 enums |
| `user.prisma` | User |
| `auth.prisma` | Session, RefreshToken, TrustedDevice, SecurityEvent |
| `location.prisma` | Zone, Ward |
| `organization.prisma` | Department, Category |
| `complaint.prisma` | ComplaintCounter, Complaint, ComplaintStatusHistory, ComplaintAssignment, Escalation, Attachment, Comment, Upvote, Feedback |
| `service-request.prisma` | ServiceType, ServiceRequest, ServiceRequestDocument |
| `payment.prisma` | Payment, PaymentEvent, Refund |
| `system.prisma` | IdempotencyKey, Notification, EmailLog, AuditLog, SystemSetting |

29 models, 11 enums.

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Primary key | UUID | ids cannot be guessed, so a leaked id is not an access grant |
| Money | `Decimal(10,2)`, serialised as `"500.00"` | floats lose money |
| Time | UTC `DateTime`, ISO 8601 in responses | no timezone bugs |
| Delete | soft `deletedAt` on owned data; cascade only on child rows | history survives |
| User delete | `Restrict` on Complaint and Payment | payment records are never orphaned |
| Status | Postgres enums | an invalid string cannot be stored |
| JSON | only raw gateway payloads, `meta` and settings | queryable data stays in columns |
| History | separate tables | updating a row never erases what it was |
| Retention | SecurityEvent 90 d, IdempotencyKey 24 h, EmailLog 30 d | tables stay small |

## Constraints (migration `db_constraints`)

Rules the application must not be the only thing enforcing:

```sql
-- Email is unique only among live users, so a soft-deleted account frees the address.
CREATE UNIQUE INDEX user_email_active_uq ON "User" (email) WHERE "deletedAt" IS NULL;

ALTER TABLE "Feedback"   ADD CONSTRAINT feedback_rating_ck  CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE "Payment"    ADD CONSTRAINT payment_amount_ck   CHECK (amount > 0);
ALTER TABLE "Refund"     ADD CONSTRAINT refund_amount_ck    CHECK (amount > 0);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_lat_ck    CHECK (latitude  IS NULL OR latitude  BETWEEN  -90 AND  90);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_lng_ck    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_upvote_ck CHECK ("upvoteCount" >= 0);
ALTER TABLE "Escalation" ADD CONSTRAINT escalation_level_ck CHECK (level BETWEEN 1 AND 3);

-- The super admin flag can only ever sit on an ADMIN row.
ALTER TABLE "User" ADD CONSTRAINT user_superadmin_ck
  CHECK ("isSuperAdmin" = false OR role = 'ADMIN');

-- One SUCCESS payment per service request; one active assignment per complaint.
CREATE UNIQUE INDEX payment_one_success_uq
  ON "Payment" ("serviceRequestId") WHERE status = 'SUCCESS';
CREATE UNIQUE INDEX assignment_active_uq
  ON "ComplaintAssignment" ("complaintId") WHERE "unassignedAt" IS NULL;

-- Trigram search works in Bangla as well as English.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX complaint_title_trgm ON "Complaint" USING gin (title gin_trgm_ops);
CREATE INDEX complaint_desc_trgm  ON "Complaint" USING gin (description gin_trgm_ops);

-- The SLA cron only ever scans open complaints.
CREATE INDEX complaint_open_sla_idx ON "Complaint" ("slaDueAt")
  WHERE status IN ('SUBMITTED','UNDER_REVIEW','ASSIGNED','IN_PROGRESS','REOPENED')
    AND "deletedAt" IS NULL;

-- AuditLog is append-only, enforced by the database itself.
CREATE TRIGGER auditlog_no_change BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
```

Because email uniqueness is a *partial* index, Prisma cannot express it as `@unique`. Code must
therefore always use `findFirst({ where: { email, deletedAt: null } })` and never
`findUnique({ where: { email } })`.

## Indexes worth knowing

| Table | Index | Serves |
| --- | --- | --- |
| Complaint | `(status, priority)` | dashboard grouping |
| Complaint | `(officerId, status)` | "my assigned" |
| Complaint | `(wardId, categoryId)` | ward and category filters |
| Complaint | `slaDueAt` plus the partial open index | the hourly SLA scan |
| Session | `(userId, revokedAt)` | session list and bulk revoke |
| SecurityEvent | `(ip, createdAt)` | brute-force investigation |
| AuditLog | `(entityType, entityId)`, `(actorId, createdAt)` | entity history and per-actor trail |

## Soft delete

`src/lib/prisma.ts` extends the client so `findMany`, `findFirst` and `count` add
`deletedAt: null` for Complaint, User, Comment, Department, Category, ServiceType and
ServiceRequest — unless the caller passes `deletedAt` explicitly. That escape hatch is how
`PATCH /admin/restore/:entity/:id` and the purge job reach deleted rows.

`findUnique` is intentionally not patched: its `where` accepts only unique fields, so a service
that looks a row up by id checks `deletedAt` itself or uses `findFirst`.

## Counters

`ComplaintCounter` holds two sequences in one table. The current year keys complaint tracking
ids (`CC-2026-000021`); the negated year keys service-request reference numbers
(`SR-2026-000012`). Both are produced by an atomic `upsert` with `increment` **inside the
caller's transaction**, so two concurrent creates can never receive the same number.

## Migrations

```bash
pnpm run db:migrate    # create and apply (development)
pnpm run db:deploy     # apply only (production)
pnpm run db:seed       # idempotent
pnpm run db:studio
```

Migrations are forward-only. A destructive change goes in two steps: add and backfill in one
release, drop in the next.
