import { z } from "zod";

/**
 * The public side is kept deliberately small. Every extra required field on an
 * unauthenticated form is another reason for someone with a real problem to
 * give up, and anything we genuinely need (a ward, a category) belongs on a
 * complaint rather than here.
 */
export const createContactMessageSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2, "Tell us your name").max(80),
			email: z.string().trim().email("Enter an email we can reply to").max(254),
			// Loose: people write numbers with country codes, hyphens or neither.
			phone: z.string().trim().max(30).optional().or(z.literal("")),
			subject: z.string().trim().min(3, "Say what it is about").max(120),
			message: z.string().trim().min(10, "A sentence or two, please").max(2000),
		})
		.strict(),
});

export const listContactMessagesSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).max(100).optional(),
			status: z.enum(["NEW", "IN_PROGRESS", "RESOLVED", "SPAM"]).optional(),
			q: z.string().trim().max(120).optional(),
		})
		.strict(),
});

export const updateContactMessageSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			status: z.enum(["NEW", "IN_PROGRESS", "RESOLVED", "SPAM"]).optional(),
			note: z.string().trim().max(1000).optional().or(z.literal("")),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export const contactMessageIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export type CreateContactMessageInput = z.infer<typeof createContactMessageSchema>["body"];
export type ListContactMessagesQuery = z.infer<typeof listContactMessagesSchema>["query"];
export type UpdateContactMessageInput = z.infer<typeof updateContactMessageSchema>["body"];
