import { describe, expect, it } from "vitest";
import { ApiError } from "@/utils/ApiError.js";
import { buildOrderBy, csv, dateRange } from "@/utils/queryBuilder.js";

describe("sort whitelist", () => {
	it("accepts a whitelisted field", () => {
		expect(buildOrderBy("complaint", "createdAt", "asc")).toEqual({ createdAt: "asc" });
	});

	it("rejects anything else with a 400", () => {
		expect(() => buildOrderBy("complaint", "hack", "desc")).toThrow(ApiError);
		try {
			buildOrderBy("complaint", "password", "desc");
		} catch (err) {
			expect((err as ApiError).statusCode).toBe(400);
			expect((err as ApiError).errors[0]?.code).toBe("VALIDATION_ERROR");
		}
	});

	it("defaults to createdAt desc", () => {
		expect(buildOrderBy("complaint", undefined, undefined)).toEqual({ createdAt: "desc" });
	});
});

describe("csv filter parsing", () => {
	it("splits a comma list", () => {
		expect(csv("ASSIGNED,IN_PROGRESS")).toEqual(["ASSIGNED", "IN_PROGRESS"]);
	});

	it("returns undefined for nothing useful", () => {
		expect(csv(undefined)).toBeUndefined();
		expect(csv(" , , ")).toBeUndefined();
	});
});

describe("date range", () => {
	it("stretches the end of the range to the end of that day", () => {
		const range = dateRange(undefined, "2026-09-17");
		expect(range?.lte?.toISOString()).toBe("2026-09-17T23:59:59.999Z");
	});

	it("is undefined when both ends are missing", () => {
		expect(dateRange()).toBeUndefined();
	});
});
