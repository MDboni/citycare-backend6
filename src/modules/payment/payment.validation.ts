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

/**
 * The staff ledger. One filter shape, spread across three endpoints, so the
 * table, the totals and the CSV can never be reading different books.
 */
const ledgerFilters = {
	status: z.enum(["PENDING", "SUCCESS", "FAILED", "CANCELLED", "REFUNDED"]).optional(),
	serviceTypeId: z.string().uuid().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	q: z.string().trim().min(2).max(100).transform(clean).optional(),
};

export const ledgerSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			...ledgerFilters,
		})
		.strict(),
});

/** No status: the summary reports every status, which is the whole point. */
export const ledgerSummarySchema = z.object({
	query: z
		.object({
			serviceTypeId: ledgerFilters.serviceTypeId,
			from: ledgerFilters.from,
			to: ledgerFilters.to,
			q: ledgerFilters.q,
		})
		.strict(),
});

export const ledgerCsvSchema = z.object({
	query: z.object(ledgerFilters).strict(),
});

export type LedgerQueryInput = z.infer<typeof ledgerSchema>["query"];
export type LedgerSummaryInput = z.infer<typeof ledgerSummarySchema>["query"];
export type LedgerCsvInput = z.infer<typeof ledgerCsvSchema>["query"];
