import sanitizeHtml from "sanitize-html";
import { z } from "zod";

const clean = (value: string) =>
	sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();

export const initiatePaymentSchema = z.object({
	body: z.object({ serviceRequestId: z.string().uuid() }).strict(),
});

export const listPaymentsSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
		})
		.strict(),
});

export const paymentIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export const refundRequestSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z.object({ reason: z.string().trim().min(5).max(500).transform(clean) }).strict(),
});
