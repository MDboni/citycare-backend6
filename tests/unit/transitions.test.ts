import { describe, expect, it } from "vitest";
import type { ComplaintStatus } from "@/generated/prisma/enums.js";
import {
	bumpPriority,
	OPEN_STATUSES,
	transitions,
} from "@/modules/complaint/complaint.constants.js";

const allows = (
	from: ComplaintStatus,
	to: ComplaintStatus,
	role: "CITIZEN" | "OFFICER" | "ADMIN",
) => transitions[from].some((t) => t.to === to && t.roles.includes(role));

describe("complaint state machine", () => {
	it("lets an admin start the review and a citizen cancel", () => {
		expect(allows("SUBMITTED", "UNDER_REVIEW", "ADMIN")).toBe(true);
		expect(allows("SUBMITTED", "CANCELLED", "CITIZEN")).toBe(true);
	});

	it("keeps each transition to the roles that own it", () => {
		expect(allows("SUBMITTED", "UNDER_REVIEW", "CITIZEN")).toBe(false);
		expect(allows("ASSIGNED", "IN_PROGRESS", "ADMIN")).toBe(false);
		expect(allows("IN_PROGRESS", "RESOLVED", "OFFICER")).toBe(true);
	});

	it("treats CLOSED, REJECTED and CANCELLED as final", () => {
		for (const status of ["CLOSED", "REJECTED", "CANCELLED"] as ComplaintStatus[]) {
			expect(transitions[status]).toHaveLength(0);
		}
	});

	it("has no edge from CLOSED back to IN_PROGRESS", () => {
		expect(allows("CLOSED", "IN_PROGRESS", "ADMIN")).toBe(false);
	});

	it("lets a citizen reopen or close a resolved complaint", () => {
		expect(allows("RESOLVED", "REOPENED", "CITIZEN")).toBe(true);
		expect(allows("RESOLVED", "CLOSED", "CITIZEN")).toBe(true);
		expect(allows("RESOLVED", "CLOSED", "ADMIN")).toBe(true);
	});

	it("never lists a final status as open", () => {
		expect(OPEN_STATUSES).not.toContain("CLOSED");
		expect(OPEN_STATUSES).not.toContain("REJECTED");
		expect(OPEN_STATUSES).toContain("REOPENED");
	});
});

describe("priority ladder", () => {
	it("moves one step up", () => {
		expect(bumpPriority("LOW")).toBe("MEDIUM");
		expect(bumpPriority("MEDIUM")).toBe("HIGH");
		expect(bumpPriority("HIGH")).toBe("URGENT");
	});

	it("stops at URGENT", () => {
		expect(bumpPriority("URGENT")).toBe("URGENT");
	});
});
