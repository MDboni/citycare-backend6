import { execSync } from "node:child_process";
import { redis } from "@/config/redis.js";
import { prisma } from "@/lib/prisma.js";

export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Applies migrations to the throwaway test database once per run.
 * Never point TEST_DATABASE_URL at anything you care about: `resetDb` truncates.
 */
export const migrateTestDb = (): void => {
	execSync("npx prisma migrate deploy", {
		stdio: "ignore",
		env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
	});
};

/** Child tables first, so foreign keys never block the wipe. */
const TABLES = [
	"PaymentEvent",
	"Refund",
	"Payment",
	"ServiceRequestDocument",
	"ServiceRequest",
	"Feedback",
	"Upvote",
	"Comment",
	"Attachment",
	"Escalation",
	"ComplaintAssignment",
	"ComplaintStatusHistory",
	"Complaint",
	"ComplaintCounter",
	"Notification",
	"EmailLog",
	"SecurityEvent",
	"IdempotencyKey",
	"RefreshToken",
	"TrustedDevice",
	"Session",
	"Category",
	"Department",
	"ServiceType",
	"Ward",
	"Zone",
	"User",
	"SystemSetting",
] as const;

export const resetDb = async (): Promise<void> => {
	// AuditLog is append-only by trigger, so it is disabled for the truncate.
	await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER auditlog_no_change');
	await prisma.$executeRawUnsafe(
		`TRUNCATE TABLE ${["AuditLog", ...TABLES].map((t) => `"${t}"`).join(", ")} CASCADE`,
	);
	await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER auditlog_no_change');
	await redis.flushdb().catch(() => {});
};

export const closeConnections = async (): Promise<void> => {
	await prisma.$disconnect();
	await redis.quit().catch(() => {});
};
