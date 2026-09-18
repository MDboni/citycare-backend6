import { CACHE_KEYS, CACHE_TTL, cached, invalidate } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";
import type {
	CreateServiceTypeInput,
	UpdateServiceTypeInput,
} from "@/modules/serviceType/serviceType.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

/** Money leaves the API as a string ("500.00") — never as a float. */
const toPublic = (s: { id: string; name: string; fee: unknown; isActive: boolean }) => ({
	id: s.id,
	name: s.name,
	fee: String(s.fee),
	isActive: s.isActive,
});

export const list = () =>
	cached(CACHE_KEYS.serviceTypes, CACHE_TTL.masterData, async () => {
		const rows = await prisma.serviceType.findMany({
			where: { isActive: true },
			orderBy: { name: "asc" },
			select: { id: true, name: true, fee: true, isActive: true },
		});
		return rows.map(toPublic);
	});

export const create = async (input: CreateServiceTypeInput, actorId: string, ctx: Ctx) => {
	const serviceType = await prisma.$transaction(async (tx) => {
		const created = await tx.serviceType.create({ data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.SERVICE_TYPE_CREATED,
			entityType: "ServiceType",
			entityId: created.id,
			after: { name: created.name, fee: String(created.fee) },
			ctx: toAuditCtx(ctx),
		});
		return created;
	});

	await invalidate(CACHE_KEYS.serviceTypes);
	return toPublic(serviceType);
};

export const update = async (
	id: string,
	input: UpdateServiceTypeInput,
	actorId: string,
	ctx: Ctx,
) => {
	const before = await prisma.serviceType.findFirst({ where: { id } });
	if (!before) throw new ApiError(404, "Service type not found", [{ code: "NOT_FOUND" }]);

	const serviceType = await prisma.$transaction(async (tx) => {
		const updated = await tx.serviceType.update({ where: { id }, data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.SERVICE_TYPE_UPDATED,
			entityType: "ServiceType",
			entityId: id,
			before: { name: before.name, fee: String(before.fee), isActive: before.isActive },
			after: { name: updated.name, fee: String(updated.fee), isActive: updated.isActive },
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});

	await invalidate(CACHE_KEYS.serviceTypes);
	return toPublic(serviceType);
};
