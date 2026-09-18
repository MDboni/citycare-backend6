import { logger } from "@/lib/logger.js";
import { sendEscalationEmail } from "@/lib/mailer.js";
import { openComplaints } from "@/lib/metrics.js";
import { prisma } from "@/lib/prisma.js";
import { OPEN_STATUSES } from "@/modules/complaint/complaint.constants.js";
import { applyStatusChange } from "@/modules/complaint/complaint.service.js";
import { dispatchEmail, notifyMany } from "@/modules/notification/notification.service.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";

/** Level 1 at the breach, 2 a day later, 3 three days after that. */
const LEVEL_DELAYS_HOURS = { 1: 0, 2: 24, 3: 96 } as const;
const AUTO_CLOSE_DAYS = 7;
const BATCH = 200;

type EscalationLevel = 1 | 2 | 3;

const levelFor = (breachedAt: Date): EscalationLevel => {
	const hours = (Date.now() - breachedAt.getTime()) / 3600_000;
	if (hours >= LEVEL_DELAYS_HOURS[3]) return 3;
	if (hours >= LEVEL_DELAYS_HOURS[2]) return 2;
	return 1;
};

/**
 * Hourly. Exported so a script or a test can trigger it without waiting an
 * hour for the cron.
 */
export const runSlaCheck = async (): Promise<{ escalated: number; autoClosed: number }> => {
	const now = new Date();

	const breached = await prisma.complaint.findMany({
		where: { status: { in: OPEN_STATUSES }, slaDueAt: { lt: now } },
		take: BATCH,
		select: {
			id: true,
			trackingId: true,
			slaDueAt: true,
			isEscalated: true,
			citizenId: true,
			status: true,
			category: { select: { department: { select: { id: true, name: true, email: true } } } },
			escalations: { select: { level: true } },
		},
	});

	const admins = await prisma.user.findMany({
		where: { role: "ADMIN", status: "ACTIVE" },
		select: { id: true },
	});
	const adminIds = admins.map((a) => a.id);

	let escalated = 0;

	for (const complaint of breached) {
		const level = levelFor(complaint.slaDueAt);
		const already = new Set(complaint.escalations.map((e) => e.level));
		if (already.has(level)) continue;

		const reason = `SLA due at ${complaint.slaDueAt.toISOString()} was missed`;

		try {
			await prisma.$transaction(async (tx) => {
				await tx.escalation.create({
					data: { complaintId: complaint.id, level, reason },
				});

				if (!complaint.isEscalated) {
					await tx.complaint.update({
						where: { id: complaint.id },
						data: { isEscalated: true },
					});
				}

				await audit(tx, {
					actorId: null,
					action: AUDIT_ACTIONS.COMPLAINT_ESCALATED,
					entityType: "Complaint",
					entityId: complaint.id,
					after: { level, reason },
				});

				await notifyMany(
					tx,
					adminIds,
					`SLA breach (level ${level})`,
					`${complaint.trackingId} has missed its SLA`,
					{ complaintId: complaint.id, level },
				);
			});

			escalated += 1;

			const departmentEmail = complaint.category.department.email;
			if (departmentEmail) {
				dispatchEmail(
					() =>
						sendEscalationEmail(departmentEmail, {
							trackingId: complaint.trackingId,
							level,
							reason,
						}),
					"sla-escalation",
				);
			}
		} catch (err) {
			// A unique-constraint clash just means another worker got there first.
			logger.warn({ err, complaintId: complaint.id }, "escalation skipped");
		}
	}

	const autoClosed = await autoCloseResolved();

	const open = await prisma.complaint.count({ where: { status: { in: OPEN_STATUSES } } });
	openComplaints.set(open);

	logger.info({ escalated, autoClosed, open }, "sla check finished");
	return { escalated, autoClosed };
};

/** A resolved complaint nobody rated closes itself after a week. */
const autoCloseResolved = async (): Promise<number> => {
	const cutoff = new Date(Date.now() - AUTO_CLOSE_DAYS * 86_400_000);

	const stale = await prisma.complaint.findMany({
		where: { status: "RESOLVED", resolvedAt: { lt: cutoff }, feedback: null },
		take: BATCH,
		select: { id: true, status: true, trackingId: true, citizenId: true },
	});

	let closed = 0;
	for (const complaint of stale) {
		try {
			await applyStatusChange({
				complaint,
				next: "CLOSED",
				note: `Auto-closed after ${AUTO_CLOSE_DAYS} days without feedback`,
				changedById: null,
			});
			closed += 1;
		} catch (err) {
			logger.warn({ err, complaintId: complaint.id }, "auto-close skipped");
		}
	}

	return closed;
};
