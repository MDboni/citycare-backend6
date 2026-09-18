import type { ResponseMeta } from "@/utils/sendResponse.js";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 10;

export type PaginationQuery = {
	page?: number;
	limit?: number;
};

export type Pagination = {
	page: number;
	limit: number;
	skip: number;
	take: number;
};

/**
 * `limit` is capped at 100 — `?limit=100000` is a denial-of-service request,
 * not a feature.
 */
export const getPagination = (query: PaginationQuery = {}): Pagination => {
	const page = Math.max(1, Math.floor(Number(query.page) || 1));
	const rawLimit = Math.floor(Number(query.limit) || DEFAULT_PAGE_SIZE);
	const limit = Math.min(Math.max(1, rawLimit), MAX_PAGE_SIZE);

	return { page, limit, skip: (page - 1) * limit, take: limit };
};

export const buildMeta = (p: Pagination, total: number): ResponseMeta => ({
	page: p.page,
	limit: p.limit,
	total,
	totalPages: Math.max(1, Math.ceil(total / p.limit)),
});
