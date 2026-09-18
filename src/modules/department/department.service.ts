import { CACHE_KEYS, CACHE_TTL, cached, invalidate } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";
import type {
	CreateDepartmentInput,
	UpdateDepartmentInput,
} from "@/modules/department/department.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

/** Public list, cached for an hour and dropped on every write. */
export const list = () =>
	cached(CACHE_KEYS.departments, CACHE_TTL.masterData, () =>
		prisma.department.findMany({
			orderBy: { name: "asc" },
			select: {
				id: true,
				name: true,
				email: true,
				_count: { select: { categories: true, officers: true } },
			},
		}),
	);

export const create = async (input: CreateDepartmentInput, actorId: string, ctx: Ctx) => {
	const department = await prisma.$transaction(async (tx) => {
		const created = await tx.department.create({ data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.DEPARTMENT_CREATED,
			entityType: "Department",
			entityId: created.id,
			after: created,
			ctx: toAuditCtx(ctx),
		});
		return created;
	});

	await invalidate(CACHE_KEYS.departments);
	return department;
};

export const update = async (
	id: string,
	input: UpdateDepartmentInput,
	actorId: string,
	ctx: Ctx,
) => {
	const before = await prisma.department.findFirst({ where: { id } });
	if (!before) throw new ApiError(404, "Department not found", [{ code: "NOT_FOUND" }]);

	const department = await prisma.$transaction(async (tx) => {
		const updated = await tx.department.update({ where: { id }, data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.DEPARTMENT_UPDATED,
			entityType: "Department",
			entityId: id,
			before: { name: before.name, email: before.email },
			after: { name: updated.name, email: updated.email },
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});

	await invalidate(CACHE_KEYS.departments);
	return department;
};

export const softDelete = async (id: string, actorId: string, ctx: Ctx) => {
	const department = await prisma.department.findFirst({ where: { id } });
	if (!department) throw new ApiError(404, "Department not found", [{ code: "NOT_FOUND" }]);

	// Deleting a department with live categories would orphan complaints.
	const categories = await prisma.category.count({ where: { departmentId: id } });
	if (categories > 0) {
		throw new ApiError(409, "Move or remove its categories first", [
			{ code: "CONFLICT", message: `${categories} categories still belong to this department` },
		]);
	}

	await prisma.$transaction(async (tx) => {
		await tx.department.update({ where: { id }, data: { deletedAt: new Date() } });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.DEPARTMENT_DELETED,
			entityType: "Department",
			entityId: id,
			before: { name: department.name },
			ctx: toAuditCtx(ctx),
		});
	});

	await invalidate(CACHE_KEYS.departments);
	return { message: "Department deleted" };
};
