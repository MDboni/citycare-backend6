-- ---------------------------------------------------------------------------
-- CityCare database constraints
-- Rules the application must never be the only thing enforcing.
-- ---------------------------------------------------------------------------

-- Email is unique only among non-deleted users, so a soft-deleted account
-- does not block re-registration. Code must therefore use
-- findFirst({ where: { email, deletedAt: null } }), never findUnique.
CREATE UNIQUE INDEX IF NOT EXISTS user_email_active_uq
  ON "User" (email) WHERE "deletedAt" IS NULL;

-- --- CHECK constraints -----------------------------------------------------
ALTER TABLE "Feedback"   ADD CONSTRAINT feedback_rating_ck   CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE "Payment"    ADD CONSTRAINT payment_amount_ck    CHECK (amount > 0);
ALTER TABLE "Refund"     ADD CONSTRAINT refund_amount_ck     CHECK (amount > 0);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_lat_ck     CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_lng_ck     CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_upvote_ck  CHECK ("upvoteCount" >= 0);
ALTER TABLE "Complaint"  ADD CONSTRAINT complaint_reopen_ck  CHECK ("reopenCount" >= 0);
ALTER TABLE "Escalation" ADD CONSTRAINT escalation_level_ck  CHECK (level BETWEEN 1 AND 3);

-- The super admin flag can only ever sit on an ADMIN row. No API can set it;
-- this is the database refusing even a compromised service.
ALTER TABLE "User" ADD CONSTRAINT user_superadmin_ck
  CHECK ("isSuperAdmin" = false OR role = 'ADMIN');

-- At most one SUCCESS payment per service request — the last line of defence
-- behind the idempotent confirm() function.
CREATE UNIQUE INDEX IF NOT EXISTS payment_one_success_uq
  ON "Payment" ("serviceRequestId") WHERE status = 'SUCCESS';

-- At most one active assignment per complaint.
CREATE UNIQUE INDEX IF NOT EXISTS assignment_active_uq
  ON "ComplaintAssignment" ("complaintId") WHERE "unassignedAt" IS NULL;

-- --- Search ----------------------------------------------------------------
-- Trigram indexes make `contains` search fast in Bangla as well as English.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS complaint_title_trgm ON "Complaint" USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS complaint_desc_trgm  ON "Complaint" USING gin (description gin_trgm_ops);

-- Partial index for the hourly SLA cron: it only ever scans open complaints.
CREATE INDEX IF NOT EXISTS complaint_open_sla_idx ON "Complaint" ("slaDueAt")
  WHERE status IN ('SUBMITTED', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED')
    AND "deletedAt" IS NULL;

-- --- AuditLog is append-only ----------------------------------------------
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auditlog_no_change ON "AuditLog";
CREATE TRIGGER auditlog_no_change
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
