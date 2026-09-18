import { ApiError } from "@/utils/ApiError.js";

export type SortOrder = "asc" | "desc";

/**
 * Sort whitelists, per module. An unknown `sortBy` is a 400 — never a silent
 * fallback, and never interpolated into a query.
 */
export const SORT_WHITELIST = {
	complaint: ["createdAt", "updatedAt", "priority", "status", "slaDueAt", "upvoteCount"],
	user: ["createdAt", "name", "email", "role", "status"],
	serviceRequest: ["createdAt", "updatedAt", "status"],
	payment: ["createdAt", "amount", "status"],
	auditLog: ["createdAt", "action"],
	notification: ["createdAt", "isRead"],
	securityEvent: ["createdAt", "type"],
} as const satisfies Record<string, readonly string[]>;

export type SortModule = keyof typeof SORT_WHITELIST;

export const buildOrderBy = <M extends SortModule>(
	module: M,
	sortBy: string | undefined,
	sortOrder: string | undefined,
	fallback: string = "createdAt",
): Record<string, SortOrder> => {
	const allowed = SORT_WHITELIST[module] as readonly string[];
	const field = sortBy ?? fallback;

	if (!allowed.includes(field)) {
		throw new ApiError(400, "Validation failed", [
			{
				field: "query.sortBy",
				code: "VALIDATION_ERROR",
				message: `sortBy must be one of: ${allowed.join(", ")}`,
			},
		]);
	}

	const order: SortOrder = sortOrder === "asc" ? "asc" : "desc";
	return { [field]: order };
};

/** `?status=ASSIGNED,IN_PROGRESS` -> ["ASSIGNED", "IN_PROGRESS"] */
export const csv = (value: string | string[] | undefined): string[] | undefined => {
	if (!value) return undefined;
	const list = (Array.isArray(value) ? value : value.split(","))
		.map((v) => v.trim())
		.filter(Boolean);
	return list.length ? list : undefined;
};

/** Inclusive date range filter, skipped entirely when both ends are absent. */
export const dateRange = (from?: string, to?: string): { gte?: Date; lte?: Date } | undefined => {
	const range: { gte?: Date; lte?: Date } = {};
	if (from) range.gte = new Date(from);
	if (to) {
		const end = new Date(to);
		end.setUTCHours(23, 59, 59, 999);
		range.lte = end;
	}
	return Object.keys(range).length ? range : undefined;
};
