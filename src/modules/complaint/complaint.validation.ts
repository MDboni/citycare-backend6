import sanitizeHtml from "sanitize-html";
import { z } from "zod";

/** Stored XSS defence: free text keeps its words and loses every tag. */
const clean = (value: string) =>
	sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();

const safeText = (min: number, max: number) => z.string().trim().min(min).max(max).transform(clean);

const status = z.enum([
	"SUBMITTED",
	"UNDER_REVIEW",
	"ASSIGNED",
	"IN_PROGRESS",
	"RESOLVED",
	"CLOSED",
	"REOPENED",
	"REJECTED",
	"CANCELLED",
]);

const priority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const createComplaintSchema = z.object({
	body: z
		.object({
			title: safeText(5, 150),
			description: safeText(10, 5000),
			categoryId: z.string().uuid(),
			wardId: z.string().uuid(),
			address: safeText(3, 300),
			latitude: z.number().min(-90).max(90).optional(),
			longitude: z.number().min(-180).max(180).optional(),
		})
		.strict(),
});

export const updateComplaintSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			title: safeText(5, 150).optional(),
			description: safeText(10, 5000).optional(),
			address: safeText(3, 300).optional(),
			latitude: z.number().min(-90).max(90).optional(),
			longitude: z.number().min(-180).max(180).optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export const listComplaintsSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			status: z.string().optional(),
			priority: priority.optional(),
			wardId: z.string().uuid().optional(),
			categoryId: z.string().uuid().optional(),
			officerId: z.string().uuid().optional(),
			isEscalated: z.enum(["true", "false"]).optional(),
			from: z.string().optional(),
			to: z.string().optional(),
			sortBy: z.string().optional(),
			sortOrder: z.enum(["asc", "desc"]).optional(),
			q: z.string().trim().max(120).optional(),
		})
		.strict(),
});

export const searchSchema = z.object({
	query: z
		.object({
			q: z.string().trim().min(1).max(120),
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
		})
		.strict(),
});

export const nearbySchema = z.object({
	query: z
		.object({
			lat: z.coerce.number().min(-90).max(90),
			lng: z.coerce.number().min(-180).max(180),
			radiusKm: z.coerce.number().min(0.1).max(50).default(2),
			limit: z.coerce.number().int().min(1).optional(),
		})
		.strict(),
});

export const complaintIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export const trackingIdSchema = z.object({
	params: z.object({
		trackingId: z
			.string()
			.trim()
			.regex(/^CC-\d{4}-\d{6}$/, "Invalid tracking id"),
	}),
});

export const changeStatusSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			status,
			note: safeText(2, 500).optional(),
		})
		.strict(),
});

export const assignSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			officerId: z.string().uuid().optional(),
			auto: z.boolean().optional(),
			reason: safeText(2, 300).optional(),
		})
		.strict()
		.refine((v) => Boolean(v.officerId) !== Boolean(v.auto), {
			message: "Provide either officerId or auto: true",
		}),
});

export const noteSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z.object({ note: safeText(2, 500).optional() }).strict(),
});

export const commentSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			body: safeText(1, 2000),
			isInternal: z.boolean().optional().default(false),
		})
		.strict(),
});

export const feedbackSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			rating: z.number().int().min(1).max(5),
			comment: safeText(1, 1000).optional(),
		})
		.strict(),
});

export const attachmentSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z.object({ kind: z.enum(["EVIDENCE", "RESOLUTION_PROOF"]).optional() }).strict(),
});

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>["body"];
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>["body"];
export type ListComplaintsQuery = z.infer<typeof listComplaintsSchema>["query"];
export type AssignInput = z.infer<typeof assignSchema>["body"];
export type CommentInput = z.infer<typeof commentSchema>["body"];
export type FeedbackInput = z.infer<typeof feedbackSchema>["body"];
