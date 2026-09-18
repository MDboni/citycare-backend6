import { CACHE_KEYS, CACHE_TTL, cached, invalidate } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";
import type { CreateWardInput, UpdateWardInput } from "@/modules/ward/ward.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

export const list = () =>
	cached(CACHE_KEYS.wards, CACHE_TTL.masterData, () =>
		prisma.ward.findMany({
			orderBy: { number: "asc" },
			select: {
				id: true,
				number: true,
				name: true,
				zone: { select: { id: true, name: true } },
			},
		}),
	);

const assertZone = async (zoneId?: string) => {
	if (!zoneId) return;
	const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
	if (!zone) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "zoneId", code: "VALIDATION_ERROR", message: "Zone does not exist" },
		]);
	}
};

export const create = async (input: CreateWardInput, actorId: string, ctx: Ctx) => {
	await assertZone(input.zoneId);

	const ward = await prisma.$transaction(async (tx) => {
		const created = await tx.ward.create({ data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.WARD_CREATED,
			entityType: "Ward",
			entityId: created.id,
			after: created,
			ctx: toAuditCtx(ctx),
		});
		return created;
	});

	await invalidate(CACHE_KEYS.wards);
	return ward;
};

export const update = async (id: string, input: UpdateWardInput, actorId: string, ctx: Ctx) => {
	const before = await prisma.ward.findUnique({ where: { id } });
	if (!before) throw new ApiError(404, "Ward not found", [{ code: "NOT_FOUND" }]);
	await assertZone(input.zoneId);

	const ward = await prisma.$transaction(async (tx) => {
		const updated = await tx.ward.update({ where: { id }, data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.WARD_UPDATED,
			entityType: "Ward",
			entityId: id,
			before: { number: before.number, name: before.name, zoneId: before.zoneId },
			after: { number: updated.number, name: updated.name, zoneId: updated.zoneId },
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});

	await invalidate(CACHE_KEYS.wards);
	return ward;
};
