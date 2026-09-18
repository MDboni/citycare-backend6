import bcrypt from "bcryptjs";
import { env } from "@/config/env.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { ComplaintStatus } from "@/generated/prisma/enums.js";
import { CACHE_KEYS, CACHE_TTL, cached, invalidate, invalidateMasterData } from "@/lib/cache.js";
import { sendOfficerInviteEmail } from "@/lib/mailer.js";
import { prisma, type TxClient } from "@/lib/prisma.js";
import { clearSettingCache, SETTING_DEFAULTS, type SettingKey } from "@/lib/settings.js";
import type {
	AuditLogsQuery,
	CreateAdminInput,
	CreateOfficerInput,
	CsvReportQuery,
	ListUsersQuery,
	SecurityEventsQuery,
} from "@/modules/admin/admin.validation.js";
import { REVOKE_REASON } from "@/modules/auth/auth.constants.js";
import { logSecurity, revokeAllSessions } from "@/modules/auth/auth.service.js";
import { OPEN_STATUSES } from "@/modules/complaint/complaint.constants.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import { dispatchEmail } from "@/modules/notification/notification.service.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { randomToken } from "@/utils/crypto.js";
import { buildMeta, getPagination } from "@/utils/pagination.js";
import { buildOrderBy, csv, dateRange } from "@/utils/queryBuilder.js";

const USER_SELECT = {
	id: true,
	name: true,
	email: true,
	phone: true,
	role: true,
	status: true,
	isSuperAdmin: true,
	twoFactorEnabled: true,
	provider: true,
	lastLoginAt: true,
	createdAt: true,
	department: { select: { id: true, name: true } },
	ward: { select: { id: true, number: true, name: true } },
} as const;

// ---------------------------------------------------------------------------
// guards that the routes cannot express
// ---------------------------------------------------------------------------

/**
 * An ADMIN may manage citizens and officers. Touching another ADMIN — or
 * yourself — needs the super admin flag.
 */
const assertMayManage = (
	target: { id: string; role: string },
	actor: Actor & { isSuperAdmin: boolean },
) => {
	if (target.id === actor.id) {
		throw new ApiError(403, "You cannot change your own role or status", [
			{ code: "FORBIDDEN_ROLE", message: "You cannot change your own role or status" },
		]);
	}
	if (target.role === "ADMIN" && !actor.isSuperAdmin) {
		throw new ApiError(403, "Only a super admin can act on another admin", [
			{ code: "SUPER_ADMIN_ONLY", message: "Only a super admin can act on another admin" },
		]);
	}
};

/** The system must never end up without a way back in. */
const assertNotLastSuperAdmin = async (tx: TxClient, userId: string) => {
	const remaining = await tx.user.count({
		where: { isSuperAdmin: true, status: "ACTIVE", deletedAt: null, id: { not: userId } },
	});
	if (remaining === 0) {
		throw new ApiError(409, "At least one active super admin must remain", [
			{ code: "LAST_SUPER_ADMIN", message: "At least one active super admin must remain" },
		]);
	}
};

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const listUsers = async (query: ListUsersQuery) => {
	const pagination = getPagination(query);
	const where: Prisma.UserWhereInput = {
		...(query.role && { role: query.role }),
		...(query.status && { status: query.status }),
		...(query.q && {
			OR: [
				{ name: { contains: query.q, mode: "insensitive" } },
				{ email: { contains: query.q, mode: "insensitive" } },
			],
		}),
	};

	const [items, total] = await Promise.all([
		prisma.user.findMany({
			where,
			select: USER_SELECT,
			orderBy: buildOrderBy("user", query.sortBy, query.sortOrder),
			skip: pagination.skip,
			take: pagination.take,
		}),
		prisma.user.count({ where }),
	]);

	return { items, meta: buildMeta(pagination, total) };
};

export const createOfficer = async (input: CreateOfficerInput, actor: Actor, ctx: Ctx) => {
	const exists = await prisma.user.findFirst({ where: { email: input.email } });
	if (exists) {
		throw new ApiError(409, "Email already registered", [
			{ code: "EMAIL_EXISTS", message: "Email already registered" },
		]);
	}

	const department = await prisma.department.findFirst({ where: { id: input.departmentId } });
	if (!department) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "departmentId", code: "VALIDATION_ERROR", message: "Department does not exist" },
		]);
	}

	// A random first password the admin never sees; the officer changes it.
	const tempPassword = `${randomToken(6)}Aa1!`;

	const officer = await prisma.$transaction(async (tx) => {
		const created = await tx.user.create({
			data: {
				name: input.name,
				email: input.email,
				phone: input.phone ?? null,
				password: await bcrypt.hash(tempPassword, env.BCRYPT_SALT_ROUNDS),
				role: "OFFICER",
				departmentId: input.departmentId,
				wardId: input.wardId ?? null,
				emailVerifiedAt: new Date(),
				twoFactorEnabled: true,
			},
			select: USER_SELECT,
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.OFFICER_CREATED,
			entityType: "User",
			entityId: created.id,
			after: { email: created.email, departmentId: input.departmentId },
			ctx: toAuditCtx(ctx),
		});

		return created;
	});

	dispatchEmail(
		() => sendOfficerInviteEmail(officer.email, { name: officer.name, tempPassword }),
		"officer-invite",
	);

	return officer;
};

export const updateRole = async (
	targetId: string,
	role: "CITIZEN" | "OFFICER" | "ADMIN",
	actor: Actor & { isSuperAdmin: boolean },
	ctx: Ctx,
) => {
	const target = await prisma.user.findFirst({ where: { id: targetId } });
	if (!target) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	assertMayManage(target, actor);
	// Granting or revoking ADMIN is a super admin decision either way.
	if (role === "ADMIN" && !actor.isSuperAdmin) {
		throw new ApiError(403, "Only a super admin can grant the ADMIN role", [
			{ code: "SUPER_ADMIN_ONLY", message: "Only a super admin can grant the ADMIN role" },
		]);
	}

	const updated = await prisma.$transaction(async (tx) => {
		if (target.isSuperAdmin && role !== "ADMIN") await assertNotLastSuperAdmin(tx, targetId);

		const row = await tx.user.update({
			where: { id: targetId },
			data: { role },
			select: USER_SELECT,
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.USER_ROLE_UPDATED,
			entityType: "User",
			entityId: targetId,
			before: { role: target.role },
			after: { role },
			ctx: toAuditCtx(ctx),
		});

		return row;
	});

	// The old token still carries the old role, so every session has to go.
	await revokeAllSessions(targetId, REVOKE_REASON.ROLE_CHANGED);
	await logSecurity({
		userId: targetId,
		type: "ROLE_CHANGED",
		ctx,
		meta: { from: target.role, to: role },
	});

	return updated;
};

export const updateStatus = async (
	targetId: string,
	status: "ACTIVE" | "BLOCKED",
	reason: string | undefined,
	actor: Actor & { isSuperAdmin: boolean },
	ctx: Ctx,
) => {
	const target = await prisma.user.findFirst({ where: { id: targetId } });
	if (!target) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	assertMayManage(target, actor);

	const updated = await prisma.$transaction(async (tx) => {
		if (target.isSuperAdmin && status === "BLOCKED") await assertNotLastSuperAdmin(tx, targetId);

		const row = await tx.user.update({
			where: { id: targetId },
			data: { status },
			select: USER_SELECT,
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.USER_STATUS_UPDATED,
			entityType: "User",
			entityId: targetId,
			before: { status: target.status },
			after: { status, reason },
			ctx: toAuditCtx(ctx),
		});

		return row;
	});

	if (status === "BLOCKED") await revokeAllSessions(targetId, REVOKE_REASON.ADMIN);
	return updated;
};

export const forceLogout = async (
	targetId: string,
	actor: Actor & { isSuperAdmin: boolean },
	ctx: Ctx,
) => {
	const target = await prisma.user.findFirst({ where: { id: targetId } });
	if (!target) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	assertMayManage(target, actor);
	const revoked = await revokeAllSessions(targetId, REVOKE_REASON.ADMIN);

	await prisma.$transaction(async (tx) => {
		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.USER_SESSIONS_REVOKED,
			entityType: "User",
			entityId: targetId,
			after: { revoked },
			ctx: toAuditCtx(ctx),
		});
	});

	await logSecurity({ userId: targetId, type: "SESSION_REVOKED", ctx });
	return { revoked };
};

// ---------------------------------------------------------------------------
// super admin only
// ---------------------------------------------------------------------------

export const createAdmin = async (input: CreateAdminInput, actor: Actor, ctx: Ctx) => {
	const exists = await prisma.user.findFirst({ where: { email: input.email } });
	if (exists) {
		throw new ApiError(409, "Email already registered", [
			{ code: "EMAIL_EXISTS", message: "Email already registered" },
		]);
	}

	return prisma.$transaction(async (tx) => {
		const created = await tx.user.create({
			data: {
				name: input.name,
				email: input.email,
				password: await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS),
				role: "ADMIN",
				emailVerifiedAt: new Date(),
				twoFactorEnabled: true,
				// isSuperAdmin is never set here — only the seed script may do that.
			},
			select: USER_SELECT,
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.ADMIN_CREATED,
			entityType: "User",
			entityId: created.id,
			after: { email: created.email },
			ctx: toAuditCtx(ctx),
		});

		return created;
	});
};

export const removeAdmin = async (targetId: string, actor: Actor, ctx: Ctx) => {
	if (targetId === actor.id) {
		throw new ApiError(403, "You cannot remove your own admin account", [
			{ code: "FORBIDDEN_ROLE", message: "You cannot remove your own admin account" },
		]);
	}

	const target = await prisma.user.findFirst({ where: { id: targetId, role: "ADMIN" } });
	if (!target) throw new ApiError(404, "Admin not found", [{ code: "NOT_FOUND" }]);

	await prisma.$transaction(async (tx) => {
		if (target.isSuperAdmin) await assertNotLastSuperAdmin(tx, targetId);

		await tx.user.update({ where: { id: targetId }, data: { deletedAt: new Date() } });
		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.ADMIN_REMOVED,
			entityType: "User",
			entityId: targetId,
			before: { email: target.email, isSuperAdmin: target.isSuperAdmin },
			ctx: toAuditCtx(ctx),
		});
	});

	await revokeAllSessions(targetId, REVOKE_REASON.ADMIN);
	return { message: "Admin removed" };
};

export const restore = async (
	entity: "complaint" | "user" | "category" | "department",
	id: string,
	actor: Actor,
	ctx: Ctx,
) => {
	// `deletedAt: { not: null }` is explicit, so the soft-delete extension steps
	// aside and lets us reach the deleted row.
	const where = { id, deletedAt: { not: null } };
	const data = { deletedAt: null };

	const restored = await prisma.$transaction(async (tx) => {
		const result =
			entity === "complaint"
				? await tx.complaint.updateMany({ where, data })
				: entity === "user"
					? await tx.user.updateMany({ where, data })
					: entity === "category"
						? await tx.category.updateMany({ where, data })
						: await tx.department.updateMany({ where, data });

		if (result.count === 0) {
			throw new ApiError(404, "No deleted record with that id", [
				{ code: "NOT_FOUND", message: "No deleted record with that id" },
			]);
		}

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.ENTITY_RESTORED,
			entityType: entity,
			entityId: id,
			after: { restored: true },
			ctx: toAuditCtx(ctx),
		});

		return result.count;
	});

	await invalidateMasterData();
	return { entity, id, restored };
};

// ---------------------------------------------------------------------------
// dashboards and reports
// ---------------------------------------------------------------------------

/**
 * Every figure comes from `groupBy`/`count`/`aggregate` — no query here ever
 * loads a row set into JavaScript to count it.
 */
export const dashboardStats = () =>
	cached(CACHE_KEYS.adminStats, CACHE_TTL.stats, async () => {
		const monthStart = new Date();
		monthStart.setUTCDate(1);
		monthStart.setUTCHours(0, 0, 0, 0);
		const dayStart = new Date();
		dayStart.setUTCHours(0, 0, 0, 0);
		const last30 = new Date(Date.now() - 30 * 86_400_000);

		const [
			byStatus,
			byPriority,
			byWard,
			byCategory,
			openCount,
			escalatedCount,
			totalUsers,
			paymentsToday,
			paymentsMonth,
			resolutionRows,
		] = await Promise.all([
			prisma.complaint.groupBy({ by: ["status"], _count: { _all: true } }),
			prisma.complaint.groupBy({ by: ["priority"], _count: { _all: true } }),
			prisma.complaint.groupBy({ by: ["wardId"], _count: { _all: true } }),
			prisma.complaint.groupBy({
				by: ["categoryId"],
				_count: { _all: true },
				orderBy: { _count: { categoryId: "desc" } },
				take: 5,
			}),
			prisma.complaint.count({ where: { status: { in: OPEN_STATUSES } } }),
			prisma.complaint.count({ where: { isEscalated: true } }),
			prisma.user.count(),
			prisma.payment.aggregate({
				where: { status: "SUCCESS", paidAt: { gte: dayStart } },
				_sum: { amount: true },
				_count: { _all: true },
			}),
			prisma.payment.aggregate({
				where: { status: "SUCCESS", paidAt: { gte: monthStart } },
				_sum: { amount: true },
				_count: { _all: true },
			}),
			prisma.$queryRaw<{ avg_hours: number | null }[]>`
				SELECT AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600)::float AS avg_hours
				FROM "Complaint"
				WHERE "resolvedAt" IS NOT NULL
					AND "deletedAt" IS NULL
					AND "resolvedAt" >= ${last30}
			`,
		]);

		// Two small lookups turn ids into names without an N+1.
		const [wards, categories] = await Promise.all([
			prisma.ward.findMany({ select: { id: true, number: true, name: true } }),
			prisma.category.findMany({ select: { id: true, name: true } }),
		]);
		const wardName = new Map(wards.map((w) => [w.id, `${w.number} — ${w.name}`]));
		const categoryName = new Map(categories.map((c) => [c.id, c.name]));

		return {
			totals: {
				complaints: byStatus.reduce((sum, row) => sum + row._count._all, 0),
				open: openCount,
				escalated: escalatedCount,
				users: totalUsers,
			},
			byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
			byPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count._all })),
			byWard: byWard.map((r) => ({
				wardId: r.wardId,
				ward: wardName.get(r.wardId) ?? r.wardId,
				count: r._count._all,
			})),
			topCategories: byCategory.map((r) => ({
				categoryId: r.categoryId,
				category: categoryName.get(r.categoryId) ?? r.categoryId,
				count: r._count._all,
			})),
			avgResolutionHours: resolutionRows[0]?.avg_hours
				? Number(resolutionRows[0].avg_hours.toFixed(2))
				: null,
			payments: {
				today: { count: paymentsToday._count._all, amount: String(paymentsToday._sum.amount ?? 0) },
				month: { count: paymentsMonth._count._all, amount: String(paymentsMonth._sum.amount ?? 0) },
			},
		};
	});

/** ADMIN sees their own trail; a super admin sees everybody's. */
export const auditLogs = async (
	query: AuditLogsQuery,
	actor: Actor & { isSuperAdmin: boolean },
) => {
	const pagination = getPagination(query);
	const created = dateRange(query.from, query.to);

	const where: Prisma.AuditLogWhereInput = {
		...(actor.isSuperAdmin ? {} : { actorId: actor.id }),
		...(query.actorId && actor.isSuperAdmin && { actorId: query.actorId }),
		...(query.action && { action: query.action }),
		...(query.entityType && { entityType: query.entityType }),
		...(created && { createdAt: created }),
	};

	const [items, total] = await Promise.all([
		prisma.auditLog.findMany({
			where,
			orderBy: buildOrderBy("auditLog", query.sortBy, query.sortOrder),
			skip: pagination.skip,
			take: pagination.take,
			include: { actor: { select: { id: true, name: true, email: true, role: true } } },
		}),
		prisma.auditLog.count({ where }),
	]);

	return { items, meta: buildMeta(pagination, total) };
};

export const securityEvents = async (query: SecurityEventsQuery) => {
	const pagination = getPagination(query);
	const created = dateRange(query.from, query.to);

	const where: Prisma.SecurityEventWhereInput = {
		...(query.type && { type: query.type }),
		...(query.ip && { ip: query.ip }),
		...(created && { createdAt: created }),
	};

	const [items, total] = await Promise.all([
		prisma.securityEvent.findMany({
			where,
			orderBy: { createdAt: "desc" },
			skip: pagination.skip,
			take: pagination.take,
		}),
		prisma.securityEvent.count({ where }),
	]);

	return { items, meta: buildMeta(pagination, total) };
};

export const slaReport = () =>
	prisma.$queryRaw<
		{
			department: string;
			total: bigint;
			breached: bigint;
			avg_resolution_hours: number | null;
			avg_rating: number | null;
		}[]
	>`
		SELECT d.name AS department,
		       COUNT(c.id)                                             AS total,
		       COUNT(c.id) FILTER (WHERE c."isEscalated")              AS breached,
		       AVG(EXTRACT(EPOCH FROM (c."resolvedAt" - c."createdAt")) / 3600)::float
		                                                               AS avg_resolution_hours,
		       AVG(f.rating)::float                                    AS avg_rating
		FROM "Department" d
		LEFT JOIN "Category"  cat ON cat."departmentId" = d.id
		LEFT JOIN "Complaint" c   ON c."categoryId" = cat.id AND c."deletedAt" IS NULL
		LEFT JOIN "Feedback"  f   ON f."complaintId" = c.id
		WHERE d."deletedAt" IS NULL
		GROUP BY d.name
		ORDER BY d.name
	`.then((rows) =>
		rows.map((r) => ({
			department: r.department,
			total: Number(r.total),
			breached: Number(r.breached),
			breachPercent: Number(r.total)
				? Number(((Number(r.breached) / Number(r.total)) * 100).toFixed(1))
				: 0,
			avgResolutionHours: r.avg_resolution_hours ? Number(r.avg_resolution_hours.toFixed(2)) : null,
			avgRating: r.avg_rating ? Number(r.avg_rating.toFixed(2)) : null,
		})),
	);

/** Streams in pages, so a 50k-row export never sits in memory. */
export const streamComplaintsCsv = async (
	query: CsvReportQuery,
	write: (chunk: string) => void,
): Promise<void> => {
	const statuses = csv(query.status) as ComplaintStatus[] | undefined;
	const created = dateRange(query.from, query.to);

	const where: Prisma.ComplaintWhereInput = {
		...(statuses && { status: { in: statuses } }),
		...(query.wardId && { wardId: query.wardId }),
		...(query.categoryId && { categoryId: query.categoryId }),
		...(created && { createdAt: created }),
	};

	write("trackingId,title,status,priority,category,ward,createdAt,slaDueAt,resolvedAt,escalated\n");

	const escapeCsv = (value: unknown) => {
		const s = value === null || value === undefined ? "" : String(value);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};

	const pageSize = 500;
	let cursor: string | undefined;

	for (;;) {
		const rows = await prisma.complaint.findMany({
			where,
			take: pageSize,
			...(cursor && { skip: 1, cursor: { id: cursor } }),
			orderBy: { id: "asc" },
			select: {
				id: true,
				trackingId: true,
				title: true,
				status: true,
				priority: true,
				createdAt: true,
				slaDueAt: true,
				resolvedAt: true,
				isEscalated: true,
				category: { select: { name: true } },
				ward: { select: { number: true, name: true } },
			},
		});

		if (!rows.length) break;

		for (const r of rows) {
			write(
				`${[
					r.trackingId,
					r.title,
					r.status,
					r.priority,
					r.category.name,
					`${r.ward.number} - ${r.ward.name}`,
					r.createdAt.toISOString(),
					r.slaDueAt.toISOString(),
					r.resolvedAt?.toISOString() ?? "",
					r.isEscalated,
				]
					.map(escapeCsv)
					.join(",")}\n`,
			);
		}

		if (rows.length < pageSize) break;
		cursor = rows[rows.length - 1]?.id;
	}
};

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export const listSettings = async () => {
	const rows = await prisma.systemSetting.findMany({ orderBy: { key: "asc" } });
	const stored = new Map(rows.map((r) => [r.key, r.value]));

	return Object.keys(SETTING_DEFAULTS).map((key) => ({
		key,
		value: stored.get(key) ?? SETTING_DEFAULTS[key as SettingKey],
		default: SETTING_DEFAULTS[key as SettingKey],
		updatedAt: rows.find((r) => r.key === key)?.updatedAt ?? null,
	}));
};

export const updateSetting = async (key: SettingKey, value: number, actor: Actor, ctx: Ctx) => {
	const before = await prisma.systemSetting.findUnique({ where: { key } });

	const setting = await prisma.$transaction(async (tx) => {
		const row = await tx.systemSetting.upsert({
			where: { key },
			create: { key, value, updatedById: actor.id },
			update: { value, updatedById: actor.id },
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.SETTING_UPDATED,
			entityType: "SystemSetting",
			entityId: key,
			before: { value: before?.value ?? SETTING_DEFAULTS[key] },
			after: { value },
			ctx: toAuditCtx(ctx),
		});

		return row;
	});

	clearSettingCache(key);
	await invalidate(CACHE_KEYS.adminStats);
	return setting;
};
