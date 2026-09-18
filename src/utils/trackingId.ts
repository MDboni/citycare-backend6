import type { TxClient } from "@/lib/prisma.js";

/**
 * Race-safe human-readable ids. The counter row is upserted with an atomic
 * `increment` inside the caller's transaction, so two concurrent creates can
 * never receive the same number.
 */
export const nextTrackingId = async (tx: TxClient): Promise<string> => {
	const year = new Date().getUTCFullYear();
	const row = await tx.complaintCounter.upsert({
		where: { year },
		create: { year, value: 1 },
		update: { value: { increment: 1 } },
	});
	return `CC-${year}-${String(row.value).padStart(6, "0")}`;
};

/**
 * Service requests share the same counter table, offset into a separate row by
 * using a negative year key — one table, two independent sequences.
 */
export const nextReferenceNo = async (tx: TxClient): Promise<string> => {
	const year = new Date().getUTCFullYear();
	const row = await tx.complaintCounter.upsert({
		where: { year: -year },
		create: { year: -year, value: 1 },
		update: { value: { increment: 1 } },
	});
	return `SR-${year}-${String(row.value).padStart(6, "0")}`;
};

export const TRACKING_ID_PATTERN = /^CC-\d{4}-\d{6}$/;
export const REFERENCE_NO_PATTERN = /^SR-\d{4}-\d{6}$/;
