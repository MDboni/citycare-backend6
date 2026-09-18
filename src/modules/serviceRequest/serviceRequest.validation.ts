import sanitizeHtml from "sanitize-html";
import { z } from "zod";

const clean = (value: string) =>
	sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();

export const createServiceRequestSchema = z.object({
	body: z
		.object({
			serviceTypeId: z.string().uuid(),
			// Free-form application payload; kept as JSON because it varies per service.
			details: z.record(z.string(), z.unknown()).optional(),
		})
		.strict(),
});

export const listServiceRequestsSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			status: z
				.enum(["PENDING_PAYMENT", "PAID", "PROCESSING", "COMPLETED", "REJECTED", "CANCELLED"])
				.optional(),
			sortBy: z.string().optional(),
			sortOrder: z.enum(["asc", "desc"]).optional(),
		})
		.strict(),
});

export const serviceRequestIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export const updateServiceRequestStatusSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			status: z.enum(["PROCESSING", "COMPLETED", "REJECTED"]),
			note: z.string().trim().max(500).transform(clean).optional(),
		})
		.strict(),
});

export const uploadDocumentSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z.object({ label: z.string().trim().min(2).max(80).transform(clean) }).strict(),
});

export const documentIdSchema = z.object({
	params: z.object({ id: z.string().uuid(), docId: z.string().uuid() }),
});

export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>["body"];
export type ListServiceRequestsQuery = z.infer<typeof listServiceRequestsSchema>["query"];
export type UpdateServiceRequestStatusInput = z.infer<
	typeof updateServiceRequestStatusSchema
>["body"];
