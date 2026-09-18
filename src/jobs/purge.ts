import crypto from "node:crypto";
import { logger } from "@/lib/logger.js";
import { prisma } from "@/lib/prisma.js";

/** Retention windows, straight from the data-privacy table. */
const RETENTION = {
	securityEventDays: 90,
	emailLogDays: 30,
	anonymiseAfterDays: 30,
} as const;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/**
 * Daily. Keeps the security tables small and honours the promise that a
 * deleted account stops being personal data after 30 days — while the
 * complaints and payments it produced stay intact.
 */
export const runPurge = async (): Promise<{
	securityEvents: number;
	idempotencyKeys: number;
	emailLogs: number;
	anonymised: number;
}> => {
	const [securityEvents, idempotencyKeys, emailLogs] = await Promise.all([
		prisma.securityEvent.deleteMany({
			where: { createdAt: { lt: daysAgo(RETENTION.securityEventDays) } },
		}),
		prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
		prisma.emailLog.deleteMany({
			where: { createdAt: { lt: daysAgo(RETENTION.emailLogDays) } },
		}),
	]);

	const anonymised = await anonymiseDeletedUsers();

	logger.info(
		{
			securityEvents: securityEvents.count,
			idempotencyKeys: idempotencyKeys.count,
			emailLogs: emailLogs.count,
			anonymised,
		},
		"retention purge finished",
	);

	return {
		securityEvents: securityEvents.count,
		idempotencyKeys: idempotencyKeys.count,
		emailLogs: emailLogs.count,
		anonymised,
	};
};

/**
 * The row survives so foreign keys hold, but nothing personal is left on it.
 * `deletedAt` is passed explicitly, which is how the soft-delete extension
 * lets this query see deleted users at all.
 */
const anonymiseDeletedUsers = async (): Promise<number> => {
	const cutoff = daysAgo(RETENTION.anonymiseAfterDays);

	const users = await prisma.user.findMany({
		where: {
			deletedAt: { lt: cutoff },
			NOT: { email: { endsWith: "@citycare.invalid" } },
		},
		select: { id: true },
		take: 500,
	});

	for (const user of users) {
		await prisma.user.update({
			where: { id: user.id },
			data: {
				name: "Deleted User",
				email: `deleted-${crypto.randomUUID()}@citycare.invalid`,
				phone: null,
				avatarUrl: null,
				password: null,
				googleId: null,
				lastLoginIp: null,
			},
		});
	}

	return users.length;
};
