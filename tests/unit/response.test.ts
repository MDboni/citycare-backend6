import { describe, expect, it, vi } from "vitest";
import { ApiError, conflict, forbidden } from "@/utils/ApiError.js";
import { sendResponse } from "@/utils/sendResponse.js";

const mockRes = () => {
	const json = vi.fn();
	const status = vi.fn(() => ({ json }));
	return { res: { status } as never, status, json };
};

describe("success envelope", () => {
	it("always carries success, message and data", () => {
		const { res, status, json } = mockRes();
		sendResponse(res, { message: "OK", data: { uptime: 1 } });

		expect(status).toHaveBeenCalledWith(200);
		expect(json).toHaveBeenCalledWith({ success: true, message: "OK", data: { uptime: 1 } });
	});

	it("uses null rather than dropping `data`", () => {
		const { res, json } = mockRes();
		sendResponse(res, { message: "Deleted" });
		expect(json.mock.calls[0]?.[0]).toMatchObject({ data: null });
	});

	it("includes meta only when there is meta", () => {
		const { res, json } = mockRes();
		sendResponse(res, { message: "List", data: [], meta: { page: 1 } });
		expect(json.mock.calls[0]?.[0]).toHaveProperty("meta.page", 1);
	});
});

describe("ApiError", () => {
	it("always has at least one error detail", () => {
		expect(new ApiError(400, "Bad").errors).toEqual([{ message: "Bad" }]);
	});

	it("keeps the code the helpers attach", () => {
		expect(conflict("Taken", "EMAIL_EXISTS").errors[0]?.code).toBe("EMAIL_EXISTS");
		expect(forbidden("No", "NOT_OWNER").statusCode).toBe(403);
	});
});
