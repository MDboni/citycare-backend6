import { uploadBuffer } from "@/config/cloudinary.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { ComplaintStatus, Role } from "@/generated/prisma/enums.js";
import { sendStatusUpdateEmail } from "@/lib/mailer.js";
import { prisma } from "@/lib/prisma.js";
import { getSetting } from "@/lib/settings.js";
import {
	AUTO_CLOSE_AFTER_DAYS,
	bumpPriority,
	DUPLICATE_WINDOW_HOURS,
	MAX_ATTACHMENTS,
	NEARBY_DUPLICATE_METERS,
	OPEN_STATUSES,
	transitions,
	UPVOTES_FOR_PRIORITY_BUMP,
} from "@/modules/complaint/complaint.constants.js";
import type {
	AssignInput,
	CommentInput,
	CreateComplaintInput,
	FeedbackInput,
	ListComplaintsQuery,
	UpdateComplaintInput,
} from "@/modules/complaint/complaint.validation.js";
import { dispatchEmail, notify } from "@/modules/notification/notification.service.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { buildMeta, getPagination } from "@/utils/pagination.js";
import { buildOrderBy, csv, dateRange } from "@/utils/queryBuilder.js";
import { nextTrackingId } from "@/utils/trackingId.js";

export type Actor = {
	id: string;
	role: Role;
	departmentId: string | null;
	email: string;
	name: string;
};

const LIST_SELECT = {
	id: true,
	trackingId: true,
	title: true,
	status: true,
	priority: true,
	address: true,
	isEscalated: true,
	upvoteCount: true,
	slaDueAt: true,
	createdAt: true,
	resolvedAt: true,
	category: { select: { id: true, name: true } },
	ward: { select: { id: true, number: true, name: true } },
	officer: { select: { id: true, name: true } },
} as const;

const DETAIL_INCLUDE = {
	category: { select: { id: true, name: true, slaHours: true, departmentId: true } },
	ward: { select: { id: true, number: true, name: true } },
	citizen: { select: { id: true, name: true, email: true, phone: true } },
	officer: { select: { id: true, name: true, email: true } },
	attachments: true,
	feedback: true,
	history: { orderBy: { createdAt: "asc" } },
} as const;

// ---------------------------------------------------------------------------
// access helpers — the second layer, after the role guard on the route
// ---------------------------------------------------------------------------

type AccessRow = { citizenId: string; officerId: string | null; categoryId: string };

const assertCanRead = async (complaint: AccessRow, actor: Actor): Promise<void> => {
	if (actor.role === "ADMIN") return;
	if (actor.role === "CITIZEN" && complaint.citizenId === actor.id) return;
	if (actor.role === "OFFICER") {
		if (complaint.officerId === actor.id) return;
		// An officer may also read anything in their own department.
		const category = await prisma.category.findFirst({
			where: { id: complaint.categoryId },
			select: { departmentId: true },
		});
		if (category && category.departmentId === actor.departmentId) return;
	}
	throw new ApiError(403, "You do not have access to this complaint", [
		{ code: "NOT_OWNER", message: "You do not have access to this complaint" },
	]);
};

const assertOwner = (complaint: { citizenId: string }, actor: Actor): void => {
	if (complaint.citizenId !== actor.id) {
		throw new ApiError(403, "You do not own this complaint", [
			{ code: "NOT_OWNER", message: "You do not own this complaint" },
		]);
	}
};

const getOrThrow = async (id: string) => {
	const complaint = await prisma.complaint.findFirst({ where: { id } });
	if (!complaint) {
		throw new ApiError(404, "Complaint not found", [
			{ code: "NOT_FOUND", message: "Complaint not found" },
		]);
	}
	return complaint;
};

/** Haversine distance in metres — used for the duplicate hint and /nearby. */
const distanceMeters = (
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number => {
	const R = 6_371_000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export const create = async (input: CreateComplaintInput, actor: Actor, ctx: Ctx) => {
	const category = await prisma.category.findFirst({ where: { id: input.categoryId } });
	if (!category) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "categoryId", code: "VALIDATION_ERROR", message: "Category does not exist" },
		]);
	}

	const ward = await prisma.ward.findUnique({ where: { id: input.wardId } });
	if (!ward) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "wardId", code: "VALIDATION_ERROR", message: "Ward does not exist" },
		]);
	}

	// Same person, same problem, same place, within a day: almost certainly a
	// double submit.
	const since = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3600_000);
	const duplicate = await prisma.complaint.findFirst({
		where: {
			citizenId: actor.id,
			categoryId: input.categoryId,
			wardId: input.wardId,
			status: { in: OPEN_STATUSES },
			createdAt: { gte: since },
		},
		select: { id: true, trackingId: true, createdAt: true },
	});
	if (duplicate) {
		throw new ApiError(409, "You already reported this in the last 24 hours", [
			{ code: "DUPLICATE_COMPLAINT", message: `Existing complaint: ${duplicate.trackingId}` },
		]);
	}

	const urgentFactor = await getSetting("URGENT_SLA_FACTOR");
	const slaHours =
		category.defaultPriority === "URGENT" ? category.slaHours * urgentFactor : category.slaHours;

	const complaint = await prisma.$transaction(async (tx) => {
		const trackingId = await nextTrackingId(tx);
		const created = await tx.complaint.create({
			data: {
				...input,
				trackingId,
				citizenId: actor.id,
				priority: category.defaultPriority,
				slaDueAt: new Date(Date.now() + slaHours * 3600_000),
			},
			select: {
				id: true,
				trackingId: true,
				title: true,
				status: true,
				priority: true,
				slaDueAt: true,
				createdAt: true,
				latitude: true,
				longitude: true,
			},
		});

		await tx.complaintStatusHistory.create({
			data: { complaintId: created.id, toStatus: "SUBMITTED", changedById: actor.id },
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.COMPLAINT_CREATED,
			entityType: "Complaint",
			entityId: created.id,
			after: { trackingId: created.trackingId, status: created.status },
			ctx: toAuditCtx(ctx),
		});

		return created;
	});

	return { ...complaint, possibleDuplicate: await findNearbyDuplicate(complaint, input) };
};

/** A hint, never a block: the citizen decides whether it is the same problem. */
const findNearbyDuplicate = async (
	created: { id: string; latitude: number | null; longitude: number | null },
	input: CreateComplaintInput,
) => {
	if (created.latitude === null || created.longitude === null) return null;

	// ~0.002 degrees is a little over 200 m — a cheap pre-filter before Haversine.
	const delta = 0.002;
	const candidates = await prisma.complaint.findMany({
		where: {
			id: { not: created.id },
			categoryId: input.categoryId,
			status: { in: OPEN_STATUSES },
			latitude: { gte: created.latitude - delta, lte: created.latitude + delta },
			longitude: { gte: created.longitude - delta, lte: created.longitude + delta },
		},
		select: { id: true, trackingId: true, title: true, latitude: true, longitude: true },
		take: 20,
	});

	for (const candidate of candidates) {
		if (candidate.latitude === null || candidate.longitude === null) continue;
		const metres = distanceMeters(
			{ lat: created.latitude, lng: created.longitude },
			{ lat: candidate.latitude, lng: candidate.longitude },
		);
		if (metres <= NEARBY_DUPLICATE_METERS) {
			return {
				id: candidate.id,
				trackingId: candidate.trackingId,
				title: candidate.title,
				distanceMeters: Math.round(metres),
			};
		}
	}
	return null;
};

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

const buildListWhere = (query: ListComplaintsQuery): Prisma.ComplaintWhereInput => {
	const statuses = csv(query.status) as ComplaintStatus[] | undefined;
	const created = dateRange(query.from, query.to);

	return {
		...(statuses && { status: { in: statuses } }),
		...(query.priority && { priority: query.priority }),
		...(query.wardId && { wardId: query.wardId }),
		...(query.categoryId && { categoryId: query.categoryId }),
		...(query.officerId && { officerId: query.officerId }),
		...(query.isEscalated && { isEscalated: query.isEscalated === "true" }),
		...(created && { createdAt: created }),
		...(query.q && {
			OR: [
				{ title: { contains: query.q, mode: "insensitive" } },
				{ description: { contains: query.q, mode: "insensitive" } },
				{ trackingId: { contains: query.q, mode: "insensitive" } },
			],
		}),
	};
};

const paginatedList = async (where: Prisma.ComplaintWhereInput, query: ListComplaintsQuery) => {
	const pagination = getPagination(query);
	const orderBy = buildOrderBy("complaint", query.sortBy, query.sortOrder);

	const [items, total] = await Promise.all([
		prisma.complaint.findMany({
			where,
			select: LIST_SELECT,
			orderBy,
			skip: pagination.skip,
			take: pagination.take,
		}),
		prisma.complaint.count({ where }),
	]);

	return { items, meta: buildMeta(pagination, total) };
};

/** ADMIN sees everything; an OFFICER only their own department. */
export const list = async (query: ListComplaintsQuery, actor: Actor) => {
	const where = buildListWhere(query);

	if (actor.role === "OFFICER") {
		where.category = { departmentId: actor.departmentId ?? "__none__" };
	}

	return paginatedList(where, actor.role === "OFFICER" ? query : query);
};

export const listMine = (query: ListComplaintsQuery, actor: Actor) =>
	paginatedList({ ...buildListWhere(query), citizenId: actor.id }, query);

export const listAssigned = (query: ListComplaintsQuery, actor: Actor) =>
	paginatedList({ ...buildListWhere(query), officerId: actor.id }, query);

/** Role-scoped search — a citizen can only ever search their own complaints. */
export const search = async (q: string, query: ListComplaintsQuery, actor: Actor) => {
	const scope: Prisma.ComplaintWhereInput =
		actor.role === "CITIZEN"
			? { citizenId: actor.id }
			: actor.role === "OFFICER"
				? { category: { departmentId: actor.departmentId ?? "__none__" } }
				: {};

	return paginatedList(
		{
			...scope,
			OR: [
				{ title: { contains: q, mode: "insensitive" } },
				{ description: { contains: q, mode: "insensitive" } },
				{ trackingId: { contains: q, mode: "insensitive" } },
			],
		},
		query,
	);
};

export const getById = async (id: string, actor: Actor) => {
	const complaint = await prisma.complaint.findFirst({ where: { id }, include: DETAIL_INCLUDE });
	if (!complaint) {
		throw new ApiError(404, "Complaint not found", [{ code: "NOT_FOUND" }]);
	}
	await assertCanRead(complaint, actor);

	const comments = await prisma.comment.findMany({
		where: {
			complaintId: id,
			// Internal notes are invisible to the citizen, by query — not by filter
			// after the fact.
			...(actor.role === "CITIZEN" ? { isInternal: false } : {}),
		},
		orderBy: { createdAt: "asc" },
	});

	// An officer only sees the citizen's phone on complaints assigned to them.
	const citizen =
		actor.role === "OFFICER" && complaint.officerId !== actor.id
			? { ...complaint.citizen, phone: null }
			: complaint.citizen;

	return { ...complaint, citizen, comments };
};

/** Public tracking — status and timeline only, never a name or an address. */
export const track = async (trackingId: string) => {
	const complaint = await prisma.complaint.findFirst({
		where: { trackingId },
		select: {
			trackingId: true,
			status: true,
			priority: true,
			isEscalated: true,
			createdAt: true,
			resolvedAt: true,
			closedAt: true,
			category: { select: { name: true } },
			ward: { select: { number: true, name: true } },
			history: {
				orderBy: { createdAt: "asc" },
				select: { fromStatus: true, toStatus: true, createdAt: true },
			},
		},
	});

	if (!complaint) {
		throw new ApiError(404, "Complaint not found", [{ code: "NOT_FOUND" }]);
	}
	return complaint;
};

export const history = async (id: string, actor: Actor) => {
	const complaint = await getOrThrow(id);
	await assertCanRead(complaint, actor);

	return prisma.complaintStatusHistory.findMany({
		where: { complaintId: id },
		orderBy: { createdAt: "asc" },
	});
};

export const nearby = async (query: {
	lat: number;
	lng: number;
	radiusKm: number;
	limit?: number;
}) => {
	// Bounding box first (it can use the index), exact Haversine second.
	const latDelta = query.radiusKm / 111;
	const lngDelta = query.radiusKm / (111 * Math.cos((query.lat * Math.PI) / 180) || 1);

	const candidates = await prisma.complaint.findMany({
		where: {
			status: { in: OPEN_STATUSES },
			latitude: { gte: query.lat - latDelta, lte: query.lat + latDelta },
			longitude: { gte: query.lng - lngDelta, lte: query.lng + lngDelta },
		},
		select: { ...LIST_SELECT, latitude: true, longitude: true },
		take: 200,
	});

	const radiusMeters = query.radiusKm * 1000;

	return candidates
		.flatMap((c) => {
			if (c.latitude === null || c.longitude === null) return [];
			const metres = distanceMeters(
				{ lat: query.lat, lng: query.lng },
				{ lat: c.latitude, lng: c.longitude },
			);
			return metres <= radiusMeters ? [{ ...c, distanceMeters: Math.round(metres) }] : [];
		})
		.sort((a, b) => a.distanceMeters - b.distanceMeters)
		.slice(0, query.limit ?? 50);
};

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

export const update = async (id: string, input: UpdateComplaintInput, actor: Actor, ctx: Ctx) => {
	const complaint = await getOrThrow(id);
	assertOwner(complaint, actor);

	// Once an officer is involved the citizen's edits would rewrite history.
	if (complaint.status !== "SUBMITTED") {
		throw new ApiError(409, "A complaint can only be edited while it is SUBMITTED", [
			{ code: "INVALID_TRANSITION", message: `Current status: ${complaint.status}` },
		]);
	}

	return prisma.$transaction(async (tx) => {
		const updated = await tx.complaint.update({ where: { id }, data: input });
		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.COMPLAINT_UPDATED,
			entityType: "Complaint",
			entityId: id,
			before: { title: complaint.title, description: complaint.description },
			after: { title: updated.title, description: updated.description },
			ctx: toAuditCtx(ctx),
		});
		return updated;
	});
};

export const softDelete = async (id: string, actor: Actor, ctx: Ctx) => {
	const complaint = await getOrThrow(id);

	await prisma.$transaction(async (tx) => {
		await tx.complaint.update({ where: { id }, data: { deletedAt: new Date() } });
		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.COMPLAINT_DELETED,
			entityType: "Complaint",
			entityId: id,
			before: { trackingId: complaint.trackingId, status: complaint.status },
			ctx: toAuditCtx(ctx),
		});
	});

	return { message: "Complaint deleted" };
};

/**
 * The single door every status change goes through.
 *
 * `updateMany` with the current status in the WHERE clause is the optimistic
 * lock: if another request already moved the row, `count` is 0 and this one
 * loses with a 409 instead of overwriting it.
 */
export const changeStatus = async (
	id: string,
	next: ComplaintStatus,
	note: string | undefined,
	actor: Actor,
	ctx: Ctx,
) => {
	const current = await getOrThrow(id);

	const edge = transitions[current.status].find((t) => t.to === next);
	if (!edge) {
		throw new ApiError(409, `Cannot change status from ${current.status} to ${next}`, [
			{
				code: "INVALID_TRANSITION",
				message: `Cannot change status from ${current.status} to ${next}`,
			},
		]);
	}
	if (!edge.roles.includes(actor.role)) {
		throw new ApiError(403, "Your role cannot make this transition", [
			{ code: "FORBIDDEN_ROLE", message: `Allowed roles: ${edge.roles.join(", ")}` },
		]);
	}

	// Ownership, on top of the role check.
	if (actor.role === "CITIZEN") assertOwner(current, actor);
	if (actor.role === "OFFICER" && current.officerId !== actor.id) {
		throw new ApiError(403, "This complaint is not assigned to you", [
			{ code: "NOT_OWNER", message: "This complaint is not assigned to you" },
		]);
	}
	if (next === "REJECTED" && !note) {
		throw new ApiError(400, "Validation failed", [
			{ field: "note", code: "VALIDATION_ERROR", message: "A note is required when rejecting" },
		]);
	}

	// "Resolved" must be provable.
	if (next === "RESOLVED") {
		const proof = await prisma.attachment.count({
			where: { complaintId: id, kind: "RESOLUTION_PROOF" },
		});
		if (proof === 0) {
			throw new ApiError(409, "Upload resolution proof before resolving", [
				{ code: "CONFLICT", message: "At least one RESOLUTION_PROOF attachment is required" },
			]);
		}
	}

	await applyStatusChange({
		complaint: current,
		next,
		note,
		changedById: actor.id,
		ctx,
	});

	const citizen = await prisma.user.findFirst({
		where: { id: current.citizenId },
		select: { email: true },
	});
	if (citizen) {
		dispatchEmail(
			() =>
				sendStatusUpdateEmail(citizen.email, {
					trackingId: current.trackingId,
					status: next,
					note,
				}),
			"complaint-status",
		);
	}

	return prisma.complaint.findFirst({ where: { id }, select: LIST_SELECT });
};

/** Shared by the API and the cron jobs (which pass `changedById: null`). */
export const applyStatusChange = async (input: {
	complaint: { id: string; status: ComplaintStatus; trackingId: string; citizenId: string };
	next: ComplaintStatus;
	note?: string | undefined;
	changedById: string | null;
	ctx?: Ctx;
}): Promise<void> => {
	const { complaint, next, note, changedById, ctx } = input;

	await prisma.$transaction(async (tx) => {
		const { count } = await tx.complaint.updateMany({
			where: { id: complaint.id, status: complaint.status, deletedAt: null },
			data: {
				status: next,
				...(next === "RESOLVED" && { resolvedAt: new Date() }),
				...(next === "CLOSED" && { closedAt: new Date() }),
				...(next === "REOPENED" && { reopenCount: { increment: 1 }, resolvedAt: null }),
			},
		});

		if (count === 0) {
			throw new ApiError(409, "Complaint was modified by someone else", [
				{ code: "CONFLICT", message: "Complaint was modified by someone else" },
			]);
		}

		await tx.complaintStatusHistory.create({
			data: {
				complaintId: complaint.id,
				fromStatus: complaint.status,
				toStatus: next,
				note: note ?? null,
				changedById,
			},
		});

		await audit(tx, {
			actorId: changedById,
			action: AUDIT_ACTIONS.COMPLAINT_STATUS_CHANGED,
			entityType: "Complaint",
			entityId: complaint.id,
			before: { status: complaint.status },
			after: { status: next },
			ctx: ctx ? toAuditCtx(ctx) : undefined,
		});

		await notify(
			tx,
			complaint.citizenId,
			"Complaint update",
			`${complaint.trackingId} is now ${next}`,
			{ complaintId: complaint.id, status: next },
		);
	});
};

export const cancel = async (id: string, note: string | undefined, actor: Actor, ctx: Ctx) =>
	changeStatus(id, "CANCELLED", note, actor, ctx);

export const reopen = async (id: string, note: string | undefined, actor: Actor, ctx: Ctx) => {
	const complaint = await getOrThrow(id);
	assertOwner(complaint, actor);

	const [limit, windowDays] = await Promise.all([
		getSetting("REOPEN_LIMIT"),
		getSetting("REOPEN_WINDOW_DAYS"),
	]);

	if (complaint.reopenCount >= limit) {
		throw new ApiError(409, `A complaint can be reopened at most ${limit} times`, [
			{ code: "CONFLICT", message: `Reopen limit of ${limit} reached` },
		]);
	}

	const deadline = complaint.resolvedAt
		? new Date(complaint.resolvedAt.getTime() + windowDays * 86_400_000)
		: null;
	if (!deadline || deadline < new Date()) {
		throw new ApiError(409, `A complaint can only be reopened within ${windowDays} days`, [
			{ code: "CONFLICT", message: "Reopen window has closed" },
		]);
	}

	return changeStatus(id, "REOPENED", note, actor, ctx);
};

// ---------------------------------------------------------------------------
// assignment
// ---------------------------------------------------------------------------

export const assign = async (id: string, input: AssignInput, actor: Actor, ctx: Ctx) => {
	const complaint = await prisma.complaint.findFirst({
		where: { id },
		include: { category: { select: { departmentId: true } } },
	});
	if (!complaint) throw new ApiError(404, "Complaint not found", [{ code: "NOT_FOUND" }]);

	const departmentId = complaint.category.departmentId;
	const officerId = input.auto
		? await pickLeastLoadedOfficer(departmentId)
		: (input.officerId as string);

	const officer = await prisma.user.findFirst({
		where: { id: officerId, role: "OFFICER", status: "ACTIVE" },
		select: { id: true, name: true, departmentId: true },
	});
	if (!officer) {
		throw new ApiError(400, "Invalid reference id", [
			{ field: "officerId", code: "VALIDATION_ERROR", message: "No such active officer" },
		]);
	}
	if (officer.departmentId !== departmentId) {
		throw new ApiError(409, "Officer belongs to a different department", [
			{ code: "CONFLICT", message: "Officer must belong to the category's department" },
		]);
	}

	// UNDER_REVIEW and REOPENED both land on ASSIGNED; anything else keeps its
	// status and just changes hands.
	const nextStatus: ComplaintStatus =
		complaint.status === "UNDER_REVIEW" || complaint.status === "REOPENED"
			? "ASSIGNED"
			: complaint.status;

	await prisma.$transaction(async (tx) => {
		await tx.complaintAssignment.updateMany({
			where: { complaintId: id, unassignedAt: null },
			data: { unassignedAt: new Date() },
		});

		await tx.complaintAssignment.create({
			data: {
				complaintId: id,
				officerId: officer.id,
				assignedById: input.auto ? null : actor.id,
				reason: input.reason ?? null,
			},
		});

		await tx.complaint.update({
			where: { id },
			data: { officerId: officer.id, status: nextStatus },
		});

		if (nextStatus !== complaint.status) {
			await tx.complaintStatusHistory.create({
				data: {
					complaintId: id,
					fromStatus: complaint.status,
					toStatus: nextStatus,
					note: input.reason ?? null,
					changedById: actor.id,
				},
			});
		}

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.COMPLAINT_ASSIGNED,
			entityType: "Complaint",
			entityId: id,
			before: { officerId: complaint.officerId, status: complaint.status },
			after: { officerId: officer.id, status: nextStatus },
			ctx: toAuditCtx(ctx),
		});

		await notify(
			tx,
			officer.id,
			"New complaint assigned",
			`${complaint.trackingId} has been assigned to you`,
			{ complaintId: id },
		);
	});

	return prisma.complaint.findFirst({ where: { id }, select: LIST_SELECT });
};

/** Fewest open complaints wins; ties break on whoever the database returns first. */
const pickLeastLoadedOfficer = async (departmentId: string): Promise<string> => {
	const officers = await prisma.user.findMany({
		where: { role: "OFFICER", status: "ACTIVE", departmentId },
		select: { id: true },
	});
	if (!officers.length) {
		throw new ApiError(409, "No active officer in this department", [
			{ code: "CONFLICT", message: "No active officer in this department" },
		]);
	}

	const loads = await prisma.complaint.groupBy({
		by: ["officerId"],
		where: { officerId: { in: officers.map((o) => o.id) }, status: { in: OPEN_STATUSES } },
		_count: { _all: true },
	});

	const loadByOfficer = new Map(loads.map((l) => [l.officerId, l._count._all]));
	return officers.reduce((best, officer) =>
		(loadByOfficer.get(officer.id) ?? 0) < (loadByOfficer.get(best.id) ?? 0) ? officer : best,
	).id;
};

// ---------------------------------------------------------------------------
// attachments, comments, upvotes, feedback
// ---------------------------------------------------------------------------

export const addAttachment = async (
	id: string,
	file: Express.Multer.File,
	kind: "EVIDENCE" | "RESOLUTION_PROOF" | undefined,
	actor: Actor,
) => {
	const complaint = await getOrThrow(id);

	const isOwner = complaint.citizenId === actor.id;
	const isAssignedOfficer = complaint.officerId === actor.id;
	const resolvedKind =
		kind ?? (isAssignedOfficer && actor.role === "OFFICER" ? "RESOLUTION_PROOF" : "EVIDENCE");

	if (resolvedKind === "EVIDENCE" && !isOwner && actor.role !== "ADMIN") {
		throw new ApiError(403, "Only the owner can add evidence", [
			{ code: "NOT_OWNER", message: "Only the owner can add evidence" },
		]);
	}
	if (resolvedKind === "RESOLUTION_PROOF" && !isAssignedOfficer && actor.role !== "ADMIN") {
		throw new ApiError(403, "Only the assigned officer can add resolution proof", [
			{ code: "NOT_OWNER", message: "Only the assigned officer can add resolution proof" },
		]);
	}

	const count = await prisma.attachment.count({ where: { complaintId: id } });
	if (count >= MAX_ATTACHMENTS) {
		throw new ApiError(409, `A complaint can hold at most ${MAX_ATTACHMENTS} attachments`, [
			{ code: "CONFLICT", message: "Attachment limit reached" },
		]);
	}

	const { url, publicId } = await uploadBuffer(file.buffer, {
		folder: `citycare/complaints/${id}`,
	});

	return prisma.attachment.create({
		data: { complaintId: id, url, publicId, kind: resolvedKind, uploadedById: actor.id },
	});
};

export const addComment = async (id: string, input: CommentInput, actor: Actor) => {
	const complaint = await getOrThrow(id);
	await assertCanRead(complaint, actor);

	if (input.isInternal && actor.role === "CITIZEN") {
		throw new ApiError(403, "Citizens cannot post internal notes", [
			{ code: "FORBIDDEN_ROLE", message: "Internal notes are staff only" },
		]);
	}

	const comment = await prisma.comment.create({
		data: {
			complaintId: id,
			authorId: actor.id,
			body: input.body,
			isInternal: Boolean(input.isInternal),
		},
	});

	// The other side of the conversation gets a notification, unless it is an
	// internal note.
	if (!comment.isInternal) {
		const recipient = actor.id === complaint.citizenId ? complaint.officerId : complaint.citizenId;
		if (recipient) {
			await prisma.notification.create({
				data: {
					userId: recipient,
					title: "New comment",
					body: `${complaint.trackingId} has a new comment`,
					meta: { complaintId: id } as never,
				},
			});
		}
	}

	return comment;
};

export const listComments = async (id: string, actor: Actor) => {
	const complaint = await getOrThrow(id);
	await assertCanRead(complaint, actor);

	return prisma.comment.findMany({
		where: { complaintId: id, ...(actor.role === "CITIZEN" ? { isInternal: false } : {}) },
		orderBy: { createdAt: "asc" },
	});
};

export const upvote = async (id: string, actor: Actor) => {
	// Existence + soft-delete check; the row itself is not needed here.
	await getOrThrow(id);

	const existing = await prisma.upvote.findUnique({
		where: { complaintId_userId: { complaintId: id, userId: actor.id } },
	});
	if (existing) {
		throw new ApiError(409, "You already upvoted this complaint", [
			{ code: "CONFLICT", message: "You already upvoted this complaint" },
		]);
	}

	const updated = await prisma.$transaction(async (tx) => {
		await tx.upvote.create({ data: { complaintId: id, userId: actor.id } });
		const row = await tx.complaint.update({
			where: { id },
			data: { upvoteCount: { increment: 1 } },
			select: { id: true, upvoteCount: true, priority: true },
		});

		// Crossing the threshold once nudges the priority up a single step.
		if (row.upvoteCount === UPVOTES_FOR_PRIORITY_BUMP) {
			const next = bumpPriority(row.priority);
			if (next !== row.priority) {
				return tx.complaint.update({
					where: { id },
					data: { priority: next },
					select: { id: true, upvoteCount: true, priority: true },
				});
			}
		}
		return row;
	});

	return updated;
};

export const feedback = async (id: string, input: FeedbackInput, actor: Actor, ctx: Ctx) => {
	const complaint = await getOrThrow(id);
	assertOwner(complaint, actor);

	if (complaint.status !== "RESOLVED" && complaint.status !== "CLOSED") {
		throw new ApiError(409, "Feedback is only possible on a resolved complaint", [
			{ code: "CONFLICT", message: `Current status: ${complaint.status}` },
		]);
	}

	const existing = await prisma.feedback.findUnique({ where: { complaintId: id } });
	if (existing) {
		throw new ApiError(409, "Feedback has already been given", [
			{ code: "CONFLICT", message: "Feedback has already been given" },
		]);
	}

	const created = await prisma.feedback.create({
		data: { complaintId: id, rating: input.rating, comment: input.comment ?? null },
	});

	// Rating a resolved complaint is what closes it.
	if (complaint.status === "RESOLVED") {
		await applyStatusChange({
			complaint,
			next: "CLOSED",
			note: "Closed by citizen feedback",
			changedById: actor.id,
			ctx,
		});
	}

	return created;
};

/** Used by the auto-close cron. */
export const AUTO_CLOSE_DAYS = AUTO_CLOSE_AFTER_DAYS;

export const listOfficerStats = async (officerId: string) => {
	const startOfMonth = new Date();
	startOfMonth.setUTCDate(1);
	startOfMonth.setUTCHours(0, 0, 0, 0);

	const [assigned, inProgress, resolvedThisMonth, slaBreaches, ratings] = await Promise.all([
		prisma.complaint.count({ where: { officerId, status: { in: OPEN_STATUSES } } }),
		prisma.complaint.count({ where: { officerId, status: "IN_PROGRESS" } }),
		prisma.complaint.count({
			where: {
				officerId,
				status: { in: ["RESOLVED", "CLOSED"] },
				resolvedAt: { gte: startOfMonth },
			},
		}),
		prisma.complaint.count({ where: { officerId, isEscalated: true } }),
		prisma.feedback.aggregate({
			where: { complaint: { officerId } },
			_avg: { rating: true },
			_count: { _all: true },
		}),
	]);

	return {
		assigned,
		inProgress,
		resolvedThisMonth,
		slaBreaches,
		avgRating: ratings._avg.rating ? Number(ratings._avg.rating.toFixed(2)) : null,
		ratingCount: ratings._count._all,
	};
};
