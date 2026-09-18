import { logger } from "@/lib/logger.js";
import { prisma, type TxClient } from "@/lib/prisma.js";
import { ApiError } from "@/utils/ApiError.js";
import { buildMeta, getPagination, type PaginationQuery } from "@/utils/pagination.js";

/**
 * In-app notification. Always called with the same `tx` as the change it
 * announces, so a rolled back status change cannot leave a stray "your
 * complaint was resolved" sitting in someone's inbox.
 */
export const notify = async (
	tx: TxClient,
	userId: string,
	title: string,
	body: string,
	meta?: Record<string, unknown>,
): Promise<void> => {
	await tx.notification.create({
		data: { userId, title, body, meta: (meta ?? undefined) as never },
	});
};

/** Same thing for several recipients (admins on an escalation, for example). */
export const notifyMany = async (
	tx: TxClient,
	userIds: string[],
	title: string,
	body: string,
	meta?: Record<string, unknown>,
): Promise<void> => {
	if (!userIds.length) return;
	await tx.notification.createMany({
		data: userIds.map((userId) => ({
			userId,
			title,
			body,
			meta: (meta ?? undefined) as never,
		})),
	});
};

/**
 * Email is fire-and-forget: a bounced SMTP connection must never fail the
 * request that triggered it. EmailLog keeps the record either way.
 */
export const dispatchEmail = (task: () => Promise<void>, context: string): void => {
	void task().catch((err) => logger.error({ err, context }, "async email dispatch failed"));
};

export const list = async (userId: string, query: PaginationQuery & { unread?: boolean }) => {
	const pagination = getPagination(query);
	const where = { userId, ...(query.unread ? { isRead: false } : {}) };

	const [items, total, unreadCount] = await Promise.all([
		prisma.notification.findMany({
			where,
			// Unread first, newest first — the order people actually want.
			orderBy: [{ isRead: "asc" }, { createdAt: "desc" }],
			skip: pagination.skip,
			take: pagination.take,
		}),
		prisma.notification.count({ where }),
		prisma.notification.count({ where: { userId, isRead: false } }),
	]);

	return { items, meta: { ...buildMeta(pagination, total), unreadCount } };
};

export const markRead = async (userId: string, id: string) => {
	const { count } = await prisma.notification.updateMany({
		where: { id, userId },
		data: { isRead: true },
	});
	if (count === 0) {
		throw new ApiError(404, "Notification not found", [
			{ code: "NOT_FOUND", message: "Notification not found" },
		]);
	}
	return { id, isRead: true };
};

export const markAllRead = async (userId: string) => {
	const { count } = await prisma.notification.updateMany({
		where: { userId, isRead: false },
		data: { isRead: true },
	});
	return { updated: count };
};
