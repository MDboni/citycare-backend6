import { CACHE_KEYS, CACHE_TTL, cached, invalidate } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";
import type { CreateZoneInput } from "@/modules/zone/zone.validation.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";

export const list = () =>
	cached(CACHE_KEYS.zones, CACHE_TTL.masterData, () =>
		prisma.zone.findMany({
			orderBy: { name: "asc" },
			select: {
				id: true,
				name: true,
				wards: { select: { id: true, number: true, name: true }, orderBy: { number: "asc" } },
			},
		}),
	);

export const create = async (input: CreateZoneInput, actorId: string, ctx: Ctx) => {
	const zone = await prisma.$transaction(async (tx) => {
		const created = await tx.zone.create({ data: input });
		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.ZONE_CREATED,
			entityType: "Zone",
			entityId: created.id,
			after: created,
			ctx: toAuditCtx(ctx),
		});
		return created;
	});

	await invalidate(CACHE_KEYS.zones);
	return zone;
};
