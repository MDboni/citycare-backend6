import { describe, expect, it } from "vitest";
import { buildMeta, getPagination, MAX_PAGE_SIZE } from "@/utils/pagination.js";

describe("pagination", () => {
	it("defaults to page 1, limit 10", () => {
		expect(getPagination()).toEqual({ page: 1, limit: 10, skip: 0, take: 10 });
	});

	it("caps limit at 100 — ?limit=1000 is a DoS request, not a feature", () => {
		expect(getPagination({ limit: 1000 }).limit).toBe(MAX_PAGE_SIZE);
		expect(getPagination({ limit: 100_000 }).take).toBe(MAX_PAGE_SIZE);
	});

	it("floors nonsense input instead of throwing", () => {
		expect(getPagination({ page: -5 }).page).toBe(1);
		// 0 reads as "not supplied", so the default applies; a negative limit floors at 1.
		expect(getPagination({ limit: 0 }).limit).toBe(10);
		expect(getPagination({ limit: -5 }).limit).toBe(1);
	});

	it("computes skip from page and limit", () => {
		expect(getPagination({ page: 3, limit: 20 }).skip).toBe(40);
	});

	it("reports totals honestly", () => {
		expect(buildMeta(getPagination({ page: 2, limit: 10 }), 35)).toEqual({
			page: 2,
			limit: 10,
			total: 35,
			totalPages: 4,
		});
	});

	it("never reports zero pages", () => {
		expect(buildMeta(getPagination(), 0).totalPages).toBe(1);
	});
});
