import { prisma } from "@/lib/prisma.js";
import type {
	CreateContactMessageInput,
	ListContactMessagesQuery,
	UpdateContactMessageInput,
} from "@/modules/contact/contact.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { buildMeta, getPagination } from "@/utils/pagination.js";

/** What the console reads. The sender never gets a record back beyond an ack. */
const MESSAGE_SELECT = {
	id: true,
	name: true,
	email: true,
	phone: true,
	subject: true,
	message: true,
	status: true,
	note: true,
	handledAt: true,
	handledBy: { select: { id: true, name: true } },
	createdAt: true,
} as const;

/**
 * Takes a message from the public contact form.
 *
 * It answers nothing but an acknowledgement on purpose: an unauthenticated
 * endpoint that echoed back an id would let anyone enumerate what else is in
 * the table, and the sender has no way to use one anyway. If they need
 * something trackable they want a complaint, which has a tracking id.
 */
export const create = async (input: CreateContactMessageInput, ctx: Ctx) => {
	await prisma.contactMessage.create({
		data: {
			name: input.name,
			email: input.email,
			phone: input.phone || null,
			subject: input.subject,
			message: input.message,
			// Kept for the same reason SecurityEvent keeps them: if this address
			// turns out to be a bot, the only way to see the pattern is the trail.
			ip: ctx.ip,
			userAgent: ctx.ua,
		},
	});

	return { message: "Thanks — your message is with the right desk." };
};

export const list = async (query: ListContactMessagesQuery) => {
	const pagination = getPagination(query);

	const where = {
		status: query.status,
		...(query.q
			? {
					OR: [
						{ name: { contains: query.q, mode: "insensitive" as const } },
						{ email: { contains: query.q, mode: "insensitive" as const } },
						{ subject: { contains: query.q, mode: "insensitive" as const } },
					],
				}
			: {}),
	};

	const [items, total, newCount] = await Promise.all([
		prisma.contactMessage.findMany({
			where,
			orderBy: { createdAt: "desc" },
			skip: pagination.skip,
			take: pagination.take,
			select: MESSAGE_SELECT,
		}),
		prisma.contactMessage.count({ where }),
		prisma.contactMessage.count({ where: { status: "NEW" } }),
	]);

	return { items, meta: { ...buildMeta(pagination, total), newCount } };
};

export const getById = async (id: string) => {
	const message = await prisma.contactMessage.findUnique({
		where: { id },
		select: MESSAGE_SELECT,
	});
	if (!message) throw new ApiError(404, "Message not found", [{ code: "NOT_FOUND" }]);
	return message;
};

export const update = async (
	id: string,
	input: UpdateContactMessageInput,
	actorId: string,
	ctx: Ctx,
) => {
	const before = await prisma.contactMessage.findUnique({ where: { id } });
	if (!before) throw new ApiError(404, "Message not found", [{ code: "NOT_FOUND" }]);

	/**
	 * Moving it off NEW is what counts as picking it up, so that is when the
	 * handler is stamped. Putting it back to NEW releases it again, which is the
	 * only way an admin can hand something back without deleting it.
	 */
	const leavingNew = input.status && input.status !== "NEW";

	const message = await prisma.$transaction(async (tx) => {
		const updated = await tx.contactMessage.update({
			where: { id },
			data: {
				status: input.status,
				...(input.note !== undefined && { note: input.note || null }),
				...(leavingNew && { handledById: actorId, handledAt: new Date() }),
				...(input.status === "NEW" && { handledById: null, handledAt: null }),
			},
			select: MESSAGE_SELECT,
		});

		await audit(tx, {
			actorId,
			action: AUDIT_ACTIONS.CONTACT_MESSAGE_UPDATED,
			entityType: "ContactMessage",
			entityId: id,
			before: { status: before.status, note: before.note },
			after: { status: updated.status, note: updated.note },
			ctx: toAuditCtx(ctx),
		});

		return updated;
	});

	return message;
};
