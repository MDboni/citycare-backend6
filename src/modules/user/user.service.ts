import { uploadBuffer } from "@/config/cloudinary.js";
import { prisma } from "@/lib/prisma.js";
import { REVOKE_REASON } from "@/modules/auth/auth.constants.js";
import { revokeAllSessions } from "@/modules/auth/auth.service.js";
import type { UpdateMeInput } from "@/modules/user/user.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

/** Explicit whitelist — a password hash can never fall out of a select like this. */
const PROFILE_SELECT = {
	id: true,
	name: true,
	email: true,
	phone: true,
	avatarUrl: true,
	role: true,
	status: true,
	provider: true,
	twoFactorEnabled: true,
	isSuperAdmin: true,
	emailVerifiedAt: true,
	lastLoginAt: true,
	createdAt: true,
	ward: { select: { id: true, number: true, name: true } },
	department: { select: { id: true, name: true } },
} as const;

export const getMe = async (userId: string) => {
	const user = await prisma.user.findFirst({ where: { id: userId }, select: PROFILE_SELECT });
	if (!user) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);
	return user;
};

export const updateMe = async (userId: string, input: UpdateMeInput) => {
	if (input.wardId) {
		const ward = await prisma.ward.findUnique({ where: { id: input.wardId } });
		if (!ward) {
			throw new ApiError(400, "Invalid reference id", [
				{ field: "wardId", code: "VALIDATION_ERROR", message: "Ward does not exist" },
			]);
		}
	}

	return prisma.user.update({ where: { id: userId }, data: input, select: PROFILE_SELECT });
};

export const updateAvatar = async (userId: string, file: Express.Multer.File) => {
	const { url } = await uploadBuffer(file.buffer, { folder: "citycare/avatars" });
	return prisma.user.update({
		where: { id: userId },
		data: { avatarUrl: url },
		select: PROFILE_SELECT,
	});
};

/**
 * Data portability: everything CityCare holds about this person, in one JSON
 * document. Secrets (password hash, token hashes) are deliberately excluded.
 */
export const exportData = async (userId: string) => {
	const [user, complaints, serviceRequests, payments, notifications, sessions, feedback] =
		await Promise.all([
			prisma.user.findFirst({ where: { id: userId }, select: PROFILE_SELECT }),
			prisma.complaint.findMany({
				where: { citizenId: userId },
				select: {
					trackingId: true,
					title: true,
					description: true,
					status: true,
					priority: true,
					address: true,
					createdAt: true,
					resolvedAt: true,
					category: { select: { name: true } },
					ward: { select: { number: true, name: true } },
				},
			}),
			prisma.serviceRequest.findMany({
				where: { citizenId: userId },
				select: {
					referenceNo: true,
					status: true,
					details: true,
					createdAt: true,
					serviceType: { select: { name: true, fee: true } },
				},
			}),
			prisma.payment.findMany({
				where: { userId },
				select: {
					transactionId: true,
					amount: true,
					currency: true,
					status: true,
					paidAt: true,
					createdAt: true,
				},
			}),
			prisma.notification.findMany({
				where: { userId },
				select: { title: true, body: true, isRead: true, createdAt: true },
			}),
			prisma.session.findMany({
				where: { userId },
				select: { ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
			}),
			prisma.feedback.findMany({
				where: { complaint: { citizenId: userId } },
				select: { rating: true, comment: true, createdAt: true },
			}),
		]);

	if (!user) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	return {
		exportedAt: new Date().toISOString(),
		profile: user,
		complaints,
		serviceRequests,
		payments: payments.map((p) => ({ ...p, amount: p.amount.toString() })),
		feedback,
		notifications,
		sessions,
	};
};

/**
 * Soft delete: the row survives (complaints and payments must never be
 * orphaned) and the purge job anonymises it after 30 days.
 */
export const deleteMe = async (userId: string, ctx: Ctx) => {
	const user = await prisma.user.findFirst({ where: { id: userId } });
	if (!user) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	if (user.isSuperAdmin) {
		const others = await prisma.user.count({
			where: { isSuperAdmin: true, status: "ACTIVE", id: { not: userId } },
		});
		if (others === 0) {
			throw new ApiError(409, "The last super admin cannot delete their own account", [
				{ code: "LAST_SUPER_ADMIN", message: "At least one super admin must remain" },
			]);
		}
	}

	await prisma.$transaction(async (tx) => {
		await tx.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
		await audit(tx, {
			actorId: userId,
			action: AUDIT_ACTIONS.USER_DELETED,
			entityType: "User",
			entityId: userId,
			ctx: toAuditCtx(ctx),
		});
	});

	await revokeAllSessions(userId, REVOKE_REASON.ADMIN);
	return { message: "Account deleted" };
};
