import { describe, expect, it, vi } from "vitest";
import { nextReferenceNo, nextTrackingId, TRACKING_ID_PATTERN } from "@/utils/trackingId.js";

/** A stand-in for the transaction client: only the counter upsert is used. */
const fakeTx = (value: number) =>
	({
		complaintCounter: { upsert: vi.fn(async () => ({ year: 2026, value })) },
	}) as never;

describe("tracking id", () => {
	it("looks like CC-2026-000021", async () => {
		const id = await nextTrackingId(fakeTx(21));
		expect(id).toMatch(TRACKING_ID_PATTERN);
		expect(id.endsWith("-000021")).toBe(true);
	});

	it("pads to six digits", async () => {
		expect(await nextTrackingId(fakeTx(1))).toMatch(/-000001$/);
		expect(await nextTrackingId(fakeTx(123456))).toMatch(/-123456$/);
	});

	it("uses a separate SR- sequence for service requests", async () => {
		expect(await nextReferenceNo(fakeTx(12))).toMatch(/^SR-\d{4}-000012$/);
	});
});
