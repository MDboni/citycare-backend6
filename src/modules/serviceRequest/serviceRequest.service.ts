import { signedUrl, uploadBuffer } from "@/config/cloudinary.js";
import type { Prisma } from "@/generated/prisma/client.js";
import { prisma } from "@/lib/prisma.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import { notify } from "@/modules/notification/notification.service.js";
import type {
	CreateServiceRequestInput,
	ListServiceRequestsQuery,
	UpdateServiceRequestStatusInput,
} from "@/modules/serviceRequest/serviceRequest.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { buildMeta, getPagination } from "@/utils/pagination.js";
import { buildOrderBy } from "@/utils/queryBuilder.js";
import { nextReferenceNo } from "@/utils/trackingId.js";

const LIST_SELECT = {
	id: true,
	referenceNo: true,
	status: true,
	createdAt: true,
	updatedAt: true,
	serviceType: { select: { id: true, name: true, fee: true } },
	citizen: { select: { id: true, name: true, email: true } },
} as const;

/** Decimal out, string back — money never becomes a float in a response. */
const toPublic = <T extends { serviceType: { fee: unknown } }>(row: T) => ({
	...row,
	serviceType: { ...row.serviceType, fee: String(row.serviceType.fee) },
});

export const create = async (input: CreateServiceRequestInput, actor: Actor, ctx: Ctx) => {
	const serviceType = await prisma.serviceType.findFirst({
		where: { id: input.serviceTypeId, isActive: true },
	});
	if (!serviceType) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "serviceTypeId", code: "VALIDATION_ERROR", message: "No such active service" },
		]);
	}

	const request = await prisma.$transaction(async (tx) => {
		const referenceNo = await nextReferenceNo(tx);
		const created = await tx.serviceRequest.create({
			data: {
				referenceNo,
				citizenId: actor.id,
				serviceTypeId: input.serviceTypeId,
				details: (input.details ?? undefined) as never,
			},
			select: LIST_SELECT,
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.SERVICE_REQUEST_CREATED,
			entityType: "ServiceRequest",
			entityId: created.id,
			after: { referenceNo, serviceTypeId: input.serviceTypeId },
			ctx: toAuditCtx(ctx),
		});

		return created;
	});

	return toPublic(request);
};

const paginated = async (
	where: Prisma.ServiceRequestWhereInput,
	query: ListServiceRequestsQuery,
) => {
	const pagination = getPagination(query);
	const orderBy = buildOrderBy("serviceRequest", query.sortBy, query.sortOrder);

	const [rows, total] = await Promise.all([
		prisma.serviceRequest.findMany({
			where,
			select: LIST_SELECT,
			orderBy,
			skip: pagination.skip,
			take: pagination.take,
		}),
		prisma.serviceRequest.count({ where }),
	]);

	return { items: rows.map(toPublic), meta: buildMeta(pagination, total) };
};

export const listMine = (query: ListServiceRequestsQuery, actor: Actor) =>
	paginated({ citizenId: actor.id, ...(query.status && { status: query.status }) }, query);

export const list = (query: ListServiceRequestsQuery) =>
	paginated({ ...(query.status && { status: query.status }) }, query);

const assertAccess = (
	request: { citizenId: string; processedById: string | null },
	actor: Actor,
): void => {
	if (actor.role === "ADMIN" || actor.role === "OFFICER") return;
	if (request.citizenId === actor.id) return;
	throw new ApiError(403, "You do not have access to this request", [
		{ code: "NOT_OWNER", message: "You do not have access to this request" },
	]);
};

export const getById = async (id: string, actor: Actor) => {
	const request = await prisma.serviceRequest.findFirst({
		where: { id },
		include: {
			serviceType: { select: { id: true, name: true, fee: true } },
			citizen: { select: { id: true, name: true, email: true } },
			documents: { select: { id: true, label: true, createdAt: true } },
			payments: {
				select: {
					id: true,
					transactionId: true,
					amount: true,
					status: true,
					paidAt: true,
					createdAt: true,
				},
			},
		},
	});

	if (!request) throw new ApiError(404, "Service request not found", [{ code: "NOT_FOUND" }]);
	assertAccess(request, actor);

	return {
		...toPublic(request),
		payments: request.payments.map((p) => ({ ...p, amount: String(p.amount) })),
	};
};

/**
 * Processing only starts once the money is in: PAID -> PROCESSING ->
 * COMPLETED | REJECTED.
 */
export const updateStatus = async (
	id: string,
	input: UpdateServiceRequestStatusInput,
	actor: Actor,
	ctx: Ctx,
) => {
	const request = await prisma.serviceRequest.findFirst({ where: { id } });
	if (!request) throw new ApiError(404, "Service request not found", [{ code: "NOT_FOUND" }]);

	const allowed: Record<string, string[]> = {
		PAID: ["PROCESSING", "REJECTED"],
		PROCESSING: ["COMPLETED", "REJECTED"],
	};

	if (!allowed[request.status]?.includes(input.status)) {
		throw new ApiError(409, `Cannot change status from ${request.status} to ${input.status}`, [
			{
				code: "INVALID_TRANSITION",
				message: `Cannot change status from ${request.status} to ${input.status}`,
			},
		]);
	}

	const updated = await prisma.$transaction(async (tx) => {
		const row = await tx.serviceRequest.update({
			where: { id },
			data: { status: input.status, processedById: actor.id },
			select: LIST_SELECT,
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.SERVICE_REQUEST_STATUS_CHANGED,
			entityType: "ServiceRequest",
			entityId: id,
			before: { status: request.status },
			after: { status: input.status, note: input.note },
			ctx: toAuditCtx(ctx),
		});

		await notify(
			tx,
			request.citizenId,
			"Service request update",
			`${request.referenceNo} is now ${input.status}`,
			{ serviceRequestId: id, status: input.status },
		);

		return row;
	});

	return toPublic(updated);
};

/**
 * NID and trade licence scans are uploaded as Cloudinary `authenticated`
 * assets, so the stored URL alone is useless without a signature.
 */
export const addDocument = async (
	id: string,
	label: string,
	file: Express.Multer.File,
	actor: Actor,
) => {
	const request = await prisma.serviceRequest.findFirst({ where: { id } });
	if (!request) throw new ApiError(404, "Service request not found", [{ code: "NOT_FOUND" }]);

	if (request.citizenId !== actor.id) {
		throw new ApiError(403, "Only the applicant can upload documents", [
			{ code: "NOT_OWNER", message: "Only the applicant can upload documents" },
		]);
	}

	const { url, publicId } = await uploadBuffer(file.buffer, {
		folder: `citycare/service-requests/${id}`,
		type: "authenticated",
		resourceType: "auto",
	});

	const doc = await prisma.serviceRequestDocument.create({
		data: { serviceRequestId: id, label, url, publicId },
	});

	return { id: doc.id, label: doc.label, createdAt: doc.createdAt };
};

/** Owner, the officer processing it, or an admin — and only for 10 minutes. */
export const getDocumentUrl = async (id: string, docId: string, actor: Actor) => {
	const request = await prisma.serviceRequest.findFirst({ where: { id } });
	if (!request) throw new ApiError(404, "Service request not found", [{ code: "NOT_FOUND" }]);

	const allowed =
		actor.role === "ADMIN" ||
		request.citizenId === actor.id ||
		(actor.role === "OFFICER" && request.processedById === actor.id);

	if (!allowed) {
		throw new ApiError(403, "You do not have access to this document", [
			{ code: "NOT_OWNER", message: "You do not have access to this document" },
		]);
	}

	const doc = await prisma.serviceRequestDocument.findFirst({
		where: { id: docId, serviceRequestId: id },
	});
	if (!doc) throw new ApiError(404, "Document not found", [{ code: "NOT_FOUND" }]);

	return { url: signedUrl(doc.publicId, 600), expiresInSec: 600, label: doc.label };
};
