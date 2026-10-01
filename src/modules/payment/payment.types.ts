import type { PaymentStatus } from "@/generated/prisma/enums.js";

/**
 * Which of the gateway's four ways in a callback arrived by.
 *
 * SSLCommerz reports the same transaction more than once — the browser redirect
 * and the server-to-server IPN both land — so the handler records which one it
 * was and stays idempotent across them.
 */
export type CallbackSource = "SUCCESS_CALLBACK" | "FAIL_CALLBACK" | "CANCEL_CALLBACK" | "IPN";

/**
 * One filter shared by the ledger table, its totals and its CSV export, so the
 * three can never disagree about what is in scope.
 */
export type LedgerQuery = {
	status?: PaymentStatus;
	serviceTypeId?: string;
	from?: string;
	to?: string;
	q?: string;
};
