import { invalidateAllPermissions, invalidateUserPermissions } from "@/lib/permissions.js";
import { prisma } from "@/lib/prisma.js";
import type {
	CreatePermissionInput,
	CreateRoleInput,
	UpdatePermissionInput,
	UpdateRoleInput,
} from "@/modules/rbac/rbac.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

const ROLE_SELECT = {
	id: true,
	name: true,
	description: true,
	isSystem: true,
	mirrors: true,
	createdAt: true,
	updatedAt: true,
	permissions: { select: { permission: { select: { id: true, code: true, name: true } } } },
	_count: { select: { users: true } },
} as const;

/** Flattens the join rows the console has no use for. */
const shapeRole = <T extends { permissions: { permission: unknown }[] }>(role: T) => ({
	...role,
	permissions: role.permissions.map((p) => p.permission),
});

// ── permissions ─────────────────────────────────────────────────────────────

export const listPermissions = async (query?: { category?: string; search?: string }) => {
	const permissions = await prisma.permission.findMany({
		where: {
			category: query?.category,
			...(query?.search
				? {
						OR: [
							{ code: { contains: query.search, mode: "insensitive" as const } },
							{ name: { contains: query.search, mode: "insensitive" as const } },
						],
					}
				: {}),
		},
		orderBy: [{ category: "asc" }, { name: "asc" }],
		select: {
			id: true,
			code: true,
			name: true,
			description: true,
			category: true,
			isSystem: true,
			_count: { select: { roles: true } },
		},
	});

	return permissions;
};

export const createPermission = async (input: CreatePermissionInput, actorId: string, ctx: Ctx) => {
	const clash = await prisma.permission.findUnique({ where: { code: input.code } });
	if (clash) {
		throw new ApiError(409, "That permission code already exists", [
			{ code: "PERMISSION_CODE_TAKEN", message: `${input.code} is already in use` },
		]);
	}

	return prisma.$transaction(async (tx) => {
		const created = await tx.permission.create({ data: { ...input, isSystem: false } });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.PERMISSION_CREATED,
			entityType: "Permission",
			entityId: created.id,
			after: created,
			ctx: toAuditCtx(ctx),
		});
		return created;
	});
};

export const updatePermission = async (
	id: string,
	input: UpdatePermissionInput,
	actorId: string,
	ctx: Ctx,
) => {
	const before = await prisma.permission.findUnique({ where: { id } });
	if (!before) throw new ApiError(404, "Permission not found");

	return prisma.$transaction(async (tx) => {
		const updated = await tx.permission.update({ where: { id }, data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.PERMISSION_UPDATED,
			entityType: "Permission",
			entityId: id,
			before,
			after: updated,
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});
};

export const deletePermission = async (id: string, actorId: string, ctx: Ctx) => {
	const before = await prisma.permission.findUnique({ where: { id } });
	if (!before) throw new ApiError(404, "Permission not found");

	/**
	 * A seeded permission is named by a route guard. Deleting it would not
	 * "open up" that route — it would make the guard reference a code no role
	 * can hold, locking out everyone except the super admin.
	 */
	if (before.isSystem) {
		throw new ApiError(409, "Built-in permissions cannot be deleted", [
			{
				code: "PERMISSION_IS_SYSTEM",
				message: "This permission is referenced by a route guard. Take it off the roles instead.",
			},
		]);
	}

	await prisma.$transaction(async (tx) => {
		await tx.permission.delete({ where: { id } });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.PERMISSION_DELETED,
			entityType: "Permission",
			entityId: id,
			before,
			ctx: toAuditCtx(ctx),
		});
	});

	await invalidateAllPermissions();
	return { message: "Permission deleted" };
};

// ── roles ───────────────────────────────────────────────────────────────────

export const listRoles = async () => {
	const roles = await prisma.accessRole.findMany({
		orderBy: [{ isSystem: "desc" }, { name: "asc" }],
		select: ROLE_SELECT,
	});
	return roles.map(shapeRole);
};

/** Guards against ids that do not exist, which would otherwise fail opaquely. */
const assertPermissionsExist = async (ids: string[]) => {
	if (ids.length === 0) return;
	const found = await prisma.permission.count({ where: { id: { in: ids } } });
	if (found !== new Set(ids).size) {
		throw new ApiError(400, "Unknown permission", [
			{ code: "PERMISSION_NOT_FOUND", message: "One or more permissions do not exist" },
		]);
	}
};

export const createRole = async (input: CreateRoleInput, actorId: string, ctx: Ctx) => {
	const clash = await prisma.accessRole.findUnique({ where: { name: input.name } });
	if (clash) {
		throw new ApiError(409, "That role name already exists", [
			{ code: "ROLE_NAME_TAKEN", message: `${input.name} is already in use` },
		]);
	}
	await assertPermissionsExist(input.permissionIds);

	const role = await prisma.$transaction(async (tx) => {
		const created = await tx.accessRole.create({
			data: {
				name: input.name,
				description: input.description,
				isSystem: false,
				permissions: {
					create: input.permissionIds.map((permissionId) => ({ permissionId })),
				},
			},
			select: ROLE_SELECT,
		});
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.ACCESS_ROLE_CREATED,
			entityType: "AccessRole",
			entityId: created.id,
			after: { name: created.name, permissions: input.permissionIds.length },
			ctx: toAuditCtx(ctx),
		});
		return created;
	});

	return shapeRole(role);
};

export const updateRole = async (id: string, input: UpdateRoleInput, actorId: string, ctx: Ctx) => {
	const before = await prisma.accessRole.findUnique({ where: { id }, select: ROLE_SELECT });
	if (!before) throw new ApiError(404, "Role not found");

	/**
	 * A system role's name is what the fallback in `getUserPermissions` is
	 * documented against, and deleting or renaming it would strand every staff
	 * member who has no explicit assignment. Its permission set stays editable —
	 * that is the whole point of the screen.
	 */
	if (before.isSystem && input.name && input.name !== before.name) {
		throw new ApiError(409, "Built-in roles cannot be renamed", [
			{ code: "ROLE_IS_SYSTEM", message: "This role is the fallback for an account type." },
		]);
	}

	if (input.permissionIds) await assertPermissionsExist(input.permissionIds);

	const role = await prisma.$transaction(async (tx) => {
		if (input.permissionIds) {
			// The payload is the whole set, so the old rows go and the new ones land.
			await tx.accessRolePermission.deleteMany({ where: { roleId: id } });
			await tx.accessRolePermission.createMany({
				data: input.permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
				skipDuplicates: true,
			});
		}

		const updated = await tx.accessRole.update({
			where: { id },
			data: { name: input.name, description: input.description },
			select: ROLE_SELECT,
		});

		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.ACCESS_ROLE_UPDATED,
			entityType: "AccessRole",
			entityId: id,
			before: { name: before.name, permissions: before.permissions.map((p) => p.permission.code) },
			after: { name: updated.name, permissions: updated.permissions.map((p) => p.permission.code) },
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});

	// Changing a role changes what every holder may do, including the holders
	// who hold it only through the system-role fallback and have no rows.
	await invalidateAllPermissions();
	return shapeRole(role);
};

export const deleteRole = async (id: string, actorId: string, ctx: Ctx) => {
	const before = await prisma.accessRole.findUnique({
		where: { id },
		select: { id: true, name: true, isSystem: true, _count: { select: { users: true } } },
	});
	if (!before) throw new ApiError(404, "Role not found");

	if (before.isSystem) {
		throw new ApiError(409, "Built-in roles cannot be deleted", [
			{
				code: "ROLE_IS_SYSTEM",
				message: "Staff with no explicit role fall back to this one.",
			},
		]);
	}
	if (before._count.users > 0) {
		throw new ApiError(409, "That role is still assigned", [
			{
				code: "ROLE_IN_USE",
				message: `${before._count.users} user(s) hold this role. Take it off them first.`,
			},
		]);
	}

	await prisma.$transaction(async (tx) => {
		await tx.accessRole.delete({ where: { id } });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.ACCESS_ROLE_DELETED,
			entityType: "AccessRole",
			entityId: id,
			before,
			ctx: toAuditCtx(ctx),
		});
	});

	await invalidateAllPermissions();
	return { message: "Role deleted" };
};

// ── assignment ──────────────────────────────────────────────────────────────

export const getUserRoles = async (userId: string) => {
	const user = await prisma.user.findFirst({
		where: { id: userId, deletedAt: null },
		select: {
			id: true,
			name: true,
			email: true,
			role: true,
			isSuperAdmin: true,
			accessRoles: { select: { roleId: true, assignedAt: true } },
		},
	});
	if (!user) throw new ApiError(404, "User not found");

	return {
		...user,
		roleIds: user.accessRoles.map((a) => a.roleId),
		/** True while the user is still riding the system-role fallback. */
		usingFallback: user.accessRoles.length === 0,
	};
};

export const assignUserRoles = async (
	userId: string,
	roleIds: string[],
	actorId: string,
	ctx: Ctx,
) => {
	const user = await prisma.user.findFirst({
		where: { id: userId, deletedAt: null },
		select: { id: true, role: true, accessRoles: { select: { roleId: true } } },
	});
	if (!user) throw new ApiError(404, "User not found");

	if (roleIds.length > 0) {
		const found = await prisma.accessRole.count({ where: { id: { in: roleIds } } });
		if (found !== new Set(roleIds).size) {
			throw new ApiError(400, "Unknown role", [
				{ code: "ROLE_NOT_FOUND", message: "One or more roles do not exist" },
			]);
		}
	}

	await prisma.$transaction(async (tx) => {
		await tx.userAccessRole.deleteMany({ where: { userId } });
		if (roleIds.length > 0) {
			await tx.userAccessRole.createMany({
				data: roleIds.map((roleId) => ({ userId, roleId })),
				skipDuplicates: true,
			});
		}
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.USER_ACCESS_ROLES_ASSIGNED,
			entityType: "User",
			entityId: userId,
			before: { roleIds: user.accessRoles.map((a) => a.roleId) },
			after: { roleIds },
			ctx: toAuditCtx(ctx),
		});
	});

	await invalidateUserPermissions(userId);
	return getUserRoles(userId);
};

/** What the signed-in user may do — the console asks on boot to build its nav. */
export const myPermissions = async (userId: string, role: string, isSuperAdmin: boolean) => {
	if (isSuperAdmin) {
		const all = await prisma.permission.findMany({ select: { code: true } });
		return { codes: all.map((p) => p.code), isSuperAdmin: true };
	}

	const { getUserPermissions } = await import("@/lib/permissions.js");
	const codes = await getUserPermissions(userId, role as never);
	return { codes: [...codes], isSuperAdmin: false };
};
