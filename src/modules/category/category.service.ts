import { CACHE_KEYS, CACHE_TTL, cached, invalidate } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";
import type {
	CreateCategoryInput,
	UpdateCategoryInput,
} from "@/modules/category/category.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

export const list = () =>
	cached(CACHE_KEYS.categories, CACHE_TTL.masterData, () =>
		prisma.category.findMany({
			orderBy: { name: "asc" },
			select: {
				id: true,
				name: true,
				slaHours: true,
				defaultPriority: true,
				department: { select: { id: true, name: true } },
			},
		}),
	);

const assertDepartment = async (departmentId: string) => {
	const department = await prisma.department.findFirst({ where: { id: departmentId } });
	if (!department) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "departmentId", code: "VALIDATION_ERROR", message: "Department does not exist" },
		]);
	}
};

export const create = async (input: CreateCategoryInput, actorId: string, ctx: Ctx) => {
	await assertDepartment(input.departmentId);

	const category = await prisma.$transaction(async (tx) => {
		const created = await tx.category.create({ data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.CATEGORY_CREATED,
			entityType: "Category",
			entityId: created.id,
			after: created,
			ctx: toAuditCtx(ctx),
		});
		return created;
	});

	await invalidate(CACHE_KEYS.categories);
	return category;
};

/**
 * An SLA change silently moves every future due date, so the before/after is
 * always written to the audit log.
 */
export const update = async (id: string, input: UpdateCategoryInput, actorId: string, ctx: Ctx) => {
	const before = await prisma.category.findFirst({ where: { id } });
	if (!before) throw new ApiError(404, "Category not found", [{ code: "NOT_FOUND" }]);
	if (input.departmentId) await assertDepartment(input.departmentId);

	const category = await prisma.$transaction(async (tx) => {
		const updated = await tx.category.update({ where: { id }, data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.CATEGORY_UPDATED,
			entityType: "Category",
			entityId: id,
			before: {
				name: before.name,
				slaHours: before.slaHours,
				defaultPriority: before.defaultPriority,
				departmentId: before.departmentId,
			},
			after: {
				name: updated.name,
				slaHours: updated.slaHours,
				defaultPriority: updated.defaultPriority,
				departmentId: updated.departmentId,
			},
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});

	await invalidate(CACHE_KEYS.categories);
	return category;
};

export const softDelete = async (id: string, actorId: string, ctx: Ctx) => {
	const category = await prisma.category.findFirst({ where: { id } });
	if (!category) throw new ApiError(404, "Category not found", [{ code: "NOT_FOUND" }]);

	const open = await prisma.complaint.count({
		where: {
			categoryId: id,
			status: { in: ["SUBMITTED", "UNDER_REVIEW", "ASSIGNED", "IN_PROGRESS", "REOPENED"] },
		},
	});
	if (open > 0) {
		throw new ApiError(409, "Category still has open complaints", [
			{ code: "CONFLICT", message: `${open} complaints are still open in this category` },
		]);
	}

	await prisma.$transaction(async (tx) => {
		await tx.category.update({ where: { id }, data: { deletedAt: new Date() } });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.CATEGORY_DELETED,
			entityType: "Category",
			entityId: id,
			before: { name: category.name },
			ctx: toAuditCtx(ctx),
		});
	});

	await invalidate(CACHE_KEYS.categories);
	return { message: "Category deleted" };
};
