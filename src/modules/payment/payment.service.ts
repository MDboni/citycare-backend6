import crypto from "node:crypto";
import SSLCommerzPayment from "sslcommerz-lts";
import { env } from "@/config/env.js";
// A value import, not a type-only one: the ledger below needs `Prisma.sql`,
// `Prisma.join` and `Prisma.Decimal` at runtime.
import { Prisma } from "@/generated/prisma/client.js";
import type { PaymentStatus } from "@/generated/prisma/enums.js";
import { logger } from "@/lib/logger.js";
import { sendReceiptEmail } from "@/lib/mailer.js";
import { paymentCounter } from "@/lib/metrics.js";
import { prisma } from "@/lib/prisma.js";
import { renderReceipt, storeReceipt } from "@/lib/receipt.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import { dispatchEmail, notify } from "@/modules/notification/notification.service.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { buildMeta, getPagination, type PaginationQuery } from "@/utils/pagination.js";
import { dateRange } from "@/utils/queryBuilder.js";

export type CallbackSource = "SUCCESS_CALLBACK" | "FAIL_CALLBACK" | "CANCEL_CALLBACK" | "IPN";

const gateway = () =>
	new SSLCommerzPayment(env.SSL_STORE_ID, env.SSL_STORE_PASSWORD, env.SSL_IS_LIVE);

const assertGatewayConfigured = () => {
	if (!env.SSL_STORE_ID || !env.SSL_STORE_PASSWORD) {
		throw new ApiError(503, "Payment gateway is not configured", [
			{ code: "SERVICE_UNAVAILABLE", message: "SSLCommerz credentials are missing" },
		]);
	}
};

const publicPayment = (p: {
	id: string;
	transactionId: string;
	amount: unknown;
	currency: string;
	status: string;
	paidAt: Date | null;
	createdAt: Date;
}) => ({ ...p, amount: String(p.amount) });

// ---------------------------------------------------------------------------
// initiate
// ---------------------------------------------------------------------------

export const initiate = async (userId: string, serviceRequestId: string, ctx: Ctx) => {
	assertGatewayConfigured();

	const sr = await prisma.serviceRequest.findFirst({
		where: { id: serviceRequestId, citizenId: userId },
		include: { serviceType: true, citizen: true },
	});
	if (!sr) {
		throw new ApiError(404, "Service request not found", [
			{ code: "NOT_FOUND", message: "Service request not found" },
		]);
	}
	if (sr.status !== "PENDING_PAYMENT") {
		throw new ApiError(409, "This request has already been paid or closed", [
			{ code: "ALREADY_PAID", message: `Current status: ${sr.status}` },
		]);
	}

	// The amount always comes from the database, never from the client.
	const tranId = `CC-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
	const payment = await prisma.payment.create({
		data: {
			transactionId: tranId,
			serviceRequestId,
			userId,
			amount: sr.serviceType.fee,
		},
	});

	const response = await gateway()
		.init({
			total_amount: Number(sr.serviceType.fee),
			currency: "BDT",
			tran_id: tranId,
			success_url: `${env.BACKEND_URL}/api/v1/payments/success`,
			fail_url: `${env.BACKEND_URL}/api/v1/payments/fail`,
			cancel_url: `${env.BACKEND_URL}/api/v1/payments/cancel`,
			ipn_url: `${env.BACKEND_URL}/api/v1/payments/ipn`,
			product_name: sr.serviceType.name,
			product_category: "Municipal service",
			product_profile: "non-physical-goods",
			shipping_method: "NO",
			cus_name: sr.citizen.name,
			cus_email: sr.citizen.email,
			cus_phone: sr.citizen.phone ?? "01700000000",
			cus_add1: "Dhaka",
			cus_city: "Dhaka",
			cus_country: "Bangladesh",
		})
		.catch((err: unknown) => {
			logger.error({ err }, "sslcommerz init failed");
			return null;
		});

	if (!response?.GatewayPageURL) {
		await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
		throw new ApiError(502, "Payment gateway error", [
			{ code: "GATEWAY_ERROR", message: response?.failedreason ?? "Gateway did not return a URL" },
		]);
	}

	await prisma.$transaction(async (tx) => {
		await audit(tx, {
			actorId: userId,
			action: AUDIT_ACTIONS.PAYMENT_INITIATED,
			entityType: "Payment",
			entityId: payment.id,
			after: { transactionId: tranId, amount: String(payment.amount) },
			ctx: toAuditCtx(ctx),
		});
	});

	return { paymentId: payment.id, transactionId: tranId, paymentUrl: response.GatewayPageURL };
};

// ---------------------------------------------------------------------------
// callbacks
// ---------------------------------------------------------------------------

/** The raw payload is stored before anything is believed about it. */
export const recordEvent = async (
	source: CallbackSource,
	payload: Record<string, unknown>,
	ip: string,
): Promise<void> => {
	const transactionId = String(payload.tran_id ?? "unknown");
	const payment = await prisma.payment.findUnique({ where: { transactionId } });

	await prisma.paymentEvent.create({
		data: {
			paymentId: payment?.id ?? null,
			transactionId,
			source,
			payload: payload as never,
			ip,
		},
	});
};

/**
 * The single verification path, shared by the browser redirect and the IPN
 * webhook, and safe to call twice for the same transaction.
 *
 * Nothing in the callback body is trusted: the gateway is asked directly, and
 * the amount it reports must match the amount stored at initiate time.
 */
export const confirm = async (tranId: string, valId: string) => {
	const payment = await prisma.payment.findUnique({
		where: { transactionId: tranId },
		include: {
			serviceRequest: { include: { serviceType: true } },
			user: { select: { id: true, name: true, email: true } },
		},
	});

	if (!payment) {
		throw new ApiError(404, "Payment not found", [
			{ code: "NOT_FOUND", message: "Payment not found" },
		]);
	}
	if (payment.status === "SUCCESS") return payment; // idempotent

	assertGatewayConfigured();

	const validation = await gateway()
		.validate({ val_id: valId })
		.catch((err: unknown) => {
			logger.error({ err, tranId }, "sslcommerz validate failed");
			return null;
		});

	const ok =
		validation !== null &&
		["VALID", "VALIDATED"].includes(String(validation.status)) &&
		validation.tran_id === tranId &&
		Number(validation.amount) === Number(payment.amount) &&
		String(validation.currency) === payment.currency;

	if (!ok) {
		paymentCounter.inc({ outcome: "invalid" });
		logger.warn({ tranId, status: validation?.status }, "payment validation rejected");
		throw new ApiError(400, "Payment validation failed", [
			{ code: "VALIDATION_ERROR", message: "Payment validation failed" },
		]);
	}

	const confirmed = await prisma.$transaction(async (tx) => {
		// Whoever gets here first flips PENDING -> SUCCESS; the loser sees count 0.
		const { count } = await tx.payment.updateMany({
			where: { id: payment.id, status: "PENDING" },
			data: {
				status: "SUCCESS",
				valId,
				paidAt: new Date(),
				gatewayResponse: validation as never,
			},
		});
		if (count === 0) return null;

		await tx.serviceRequest.update({
			where: { id: payment.serviceRequestId },
			data: { status: "PAID" },
		});

		await audit(tx, {
			actorId: payment.userId,
			action: AUDIT_ACTIONS.PAYMENT_SUCCESS,
			entityType: "Payment",
			entityId: payment.id,
			after: { transactionId: tranId, amount: String(payment.amount) },
		});

		await notify(
			tx,
			payment.userId,
			"Payment received",
			`Transaction ${tranId} completed successfully`,
			{ paymentId: payment.id },
		);

		await tx.paymentEvent.updateMany({
			where: { transactionId: tranId, processed: false },
			data: { processed: true, signatureOk: true },
		});

		return true;
	});

	// Another request already confirmed it — exactly one audit row, one email.
	if (confirmed === null) return payment;

	paymentCounter.inc({ outcome: "success" });

	dispatchEmail(async () => {
		const pdf = await renderReceipt({
			transactionId: tranId,
			referenceNo: payment.serviceRequest.referenceNo,
			serviceName: payment.serviceRequest.serviceType.name,
			amount: String(payment.amount),
			currency: payment.currency,
			payerName: payment.user.name,
			payerEmail: payment.user.email,
			paidAt: new Date(),
		}).catch((err: unknown) => {
			// A receipt that will not render must not cost the payer their email.
			logger.error({ err, tranId }, "receipt render failed");
			return null;
		});

		const receiptUrl = pdf ? await storeReceipt(pdf, tranId) : null;

		await sendReceiptEmail(payment.user.email, {
			transactionId: tranId,
			amount: String(payment.amount),
			serviceName: payment.serviceRequest.serviceType.name,
			referenceNo: payment.serviceRequest.referenceNo,
			...(receiptUrl && { receiptUrl }),
			...(pdf && { pdf }),
		});
	}, "payment-receipt");

	return payment;
};

/** fail / cancel: only a PENDING payment may move, so a late callback is inert. */
export const markTerminal = async (
	tranId: string,
	status: "FAILED" | "CANCELLED",
): Promise<void> => {
	const { count } = await prisma.payment.updateMany({
		where: { transactionId: tranId, status: "PENDING" },
		data: { status },
	});
	if (count > 0) paymentCounter.inc({ outcome: status.toLowerCase() });
};

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export const listMine = async (userId: string, query: PaginationQuery) => {
	const pagination = getPagination(query);
	const where = { userId };

	const [rows, total] = await Promise.all([
		prisma.payment.findMany({
			where,
			orderBy: { createdAt: "desc" },
			skip: pagination.skip,
			take: pagination.take,
			select: {
				id: true,
				transactionId: true,
				amount: true,
				currency: true,
				status: true,
				paidAt: true,
				createdAt: true,
				// The id and status are what let the payments list send an unpaid row
				// back to its checkout instead of being a dead record of a failed try.
				serviceRequest: {
					select: {
						id: true,
						referenceNo: true,
						status: true,
						serviceType: { select: { name: true } },
					},
				},
			},
		}),
		prisma.payment.count({ where }),
	]);

	return { items: rows.map(publicPayment), meta: buildMeta(pagination, total) };
};

export const getById = async (id: string, actor: Actor) => {
	const payment = await prisma.payment.findUnique({
		where: { id },
		include: {
			serviceRequest: { select: { referenceNo: true, status: true } },
			refund: true,
		},
	});

	if (!payment) throw new ApiError(404, "Payment not found", [{ code: "NOT_FOUND" }]);
	if (actor.role !== "ADMIN" && payment.userId !== actor.id) {
		throw new ApiError(403, "You do not have access to this payment", [
			{ code: "NOT_OWNER", message: "You do not have access to this payment" },
		]);
	}

	return {
		...publicPayment(payment),
		refund: payment.refund ? { ...payment.refund, amount: String(payment.refund.amount) } : null,
	};
};

/**
 * The receipt PDF for one payment.
 *
 * Rendered on demand from the payment row rather than served from storage: the
 * bytes cannot drift from the record, there is no public URL to leak, and the
 * ownership check is the same one every other payment read goes through. Only a
 * SUCCESS payment has a receipt — a pending or failed attempt has nothing to
 * certify, and handing out a document that looks like proof of payment for one
 * would be worse than refusing.
 */
export const getReceipt = async (paymentId: string, actor: Actor) => {
	const payment = await prisma.payment.findUnique({
		where: { id: paymentId },
		include: {
			serviceRequest: { select: { referenceNo: true, serviceType: { select: { name: true } } } },
			user: { select: { name: true, email: true } },
		},
	});

	if (!payment) throw new ApiError(404, "Payment not found", [{ code: "NOT_FOUND" }]);
	if (actor.role !== "ADMIN" && payment.userId !== actor.id) {
		throw new ApiError(403, "You do not have access to this payment", [
			{ code: "NOT_OWNER", message: "You do not have access to this payment" },
		]);
	}
	if (payment.status !== "SUCCESS") {
		throw new ApiError(409, "Only a completed payment has a receipt", [
			{ code: "CONFLICT", message: `Current status: ${payment.status}` },
		]);
	}

	const pdf = await renderReceipt({
		transactionId: payment.transactionId,
		referenceNo: payment.serviceRequest.referenceNo,
		serviceName: payment.serviceRequest.serviceType.name,
		amount: String(payment.amount),
		currency: payment.currency,
		payerName: payment.user.name,
		payerEmail: payment.user.email,
		// paidAt is written in the same update that sets SUCCESS; updatedAt is only
		// a fallback for a row migrated in before that was true.
		paidAt: payment.paidAt ?? payment.updatedAt,
	});

	return { pdf, filename: `CityCare-receipt-${payment.transactionId}.pdf` };
};

// ---------------------------------------------------------------------------
// refunds — an admin asks, a super admin approves
// ---------------------------------------------------------------------------

export const requestRefund = async (paymentId: string, reason: string, actor: Actor, ctx: Ctx) => {
	const payment = await prisma.payment.findUnique({
		where: { id: paymentId },
		include: { refund: true },
	});

	if (!payment) throw new ApiError(404, "Payment not found", [{ code: "NOT_FOUND" }]);
	if (payment.status !== "SUCCESS") {
		throw new ApiError(409, "Only a successful payment can be refunded", [
			{ code: "CONFLICT", message: `Current status: ${payment.status}` },
		]);
	}
	if (payment.refund) {
		throw new ApiError(409, "A refund has already been requested", [
			{ code: "CONFLICT", message: `Refund status: ${payment.refund.status}` },
		]);
	}

	return prisma.$transaction(async (tx) => {
		const refund = await tx.refund.create({
			data: { paymentId, amount: payment.amount, reason, requestedById: actor.id },
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.PAYMENT_REFUND_REQUESTED,
			entityType: "Payment",
			entityId: paymentId,
			after: { refundId: refund.id, reason },
			ctx: toAuditCtx(ctx),
		});

		return { ...refund, amount: String(refund.amount) };
	});
};

export const approveRefund = async (paymentId: string, actor: Actor, ctx: Ctx) => {
	assertGatewayConfigured();

	const payment = await prisma.payment.findUnique({
		where: { id: paymentId },
		include: { refund: true, serviceRequest: true },
	});

	if (!payment?.refund) {
		throw new ApiError(404, "Refund request not found", [{ code: "NOT_FOUND" }]);
	}
	if (payment.refund.status !== "REQUESTED") {
		throw new ApiError(409, "This refund has already been processed", [
			{ code: "CONFLICT", message: `Refund status: ${payment.refund.status}` },
		]);
	}

	const bankTranId = String(
		(payment.gatewayResponse as { bank_tran_id?: string } | null)?.bank_tran_id ?? "",
	);
	if (!bankTranId) {
		throw new ApiError(409, "Gateway transaction reference is missing", [
			{ code: "CONFLICT", message: "bank_tran_id was not stored for this payment" },
		]);
	}

	const result = await gateway()
		.initiateRefund({
			refund_amount: Number(payment.amount),
			refund_remarks: payment.refund.reason.slice(0, 255),
			bank_tran_id: bankTranId,
			refe_id: payment.transactionId,
		})
		.catch((err: unknown) => {
			logger.error({ err, paymentId }, "sslcommerz refund failed");
			return null;
		});

	if (!result || String(result.APIConnect) !== "DONE") {
		throw new ApiError(502, "Refund could not be processed by the gateway", [
			{ code: "GATEWAY_ERROR", message: result?.errorReason ?? "Gateway refused the refund" },
		]);
	}

	const refund = await prisma.$transaction(async (tx) => {
		const updated = await tx.refund.update({
			where: { paymentId },
			data: {
				status: "PROCESSED",
				approvedById: actor.id,
				gatewayRefId: result.refund_ref_id ?? null,
				processedAt: new Date(),
			},
		});

		await tx.payment.update({ where: { id: paymentId }, data: { status: "REFUNDED" } });
		await tx.serviceRequest.update({
			where: { id: payment.serviceRequestId },
			data: { status: "CANCELLED" },
		});

		await audit(tx, {
			actorId: actor.id,
			action: AUDIT_ACTIONS.PAYMENT_REFUNDED,
			entityType: "Payment",
			entityId: paymentId,
			before: { status: payment.status },
			after: { status: "REFUNDED", gatewayRefId: result.refund_ref_id },
			ctx: toAuditCtx(ctx),
		});

		await notify(
			tx,
			payment.userId,
			"Payment refunded",
			`Transaction ${payment.transactionId} has been refunded`,
			{ paymentId },
		);

		return updated;
	});

	paymentCounter.inc({ outcome: "refunded" });
	return { ...refund, amount: String(refund.amount) };
};

// ---------------------------------------------------------------------------
// the ledger — what the console reads to answer "how much came in"
// ---------------------------------------------------------------------------

/**
 * Money leaves this module as a string, never as a number.
 *
 * `amount` is `Decimal(10,2)` in the database and a `Decimal` in the client.
 * Turning one into a JavaScript number to add it up is how a ledger ends up a
 * paisa short of the bank, and `JSON.stringify` of a Decimal is an object
 * rather than a figure. Every sum here is done by the database and stringified
 * on the way out; the console formats it and does no arithmetic on it either.
 */
const money = (value: Prisma.Decimal | null) => String(value ?? 0);

export type LedgerQuery = {
	status?: PaymentStatus;
	serviceTypeId?: string;
	from?: string;
	to?: string;
	q?: string;
};

/**
 * One filter, built once, so the table, the totals and the export can never
 * disagree about what is in scope.
 *
 * The range is on `createdAt`, not `paidAt`, and that is deliberate: a pending
 * or failed attempt never gets a `paidAt`, so a range that filtered on it would
 * quietly drop every unsuccessful attempt and make the failure rate on this
 * page a fiction. The daily series below is the one place `paidAt` is right,
 * because there the question really is when the money landed.
 */
const ledgerWhere = (query: LedgerQuery): Prisma.PaymentWhereInput => {
	const created = dateRange(query.from, query.to);
	const term = query.q?.trim();
	const like = { contains: term, mode: "insensitive" as const };

	return {
		...(query.status && { status: query.status }),
		...(created && { createdAt: created }),
		...(query.serviceTypeId && { serviceRequest: { serviceTypeId: query.serviceTypeId } }),
		...(term && {
			OR: [
				{ transactionId: like },
				{ serviceRequest: { referenceNo: like } },
				{ user: { name: like } },
				{ user: { email: like } },
			],
		}),
	};
};

/** Every transaction, whoever made it. `listMine` is the citizen-facing one. */
export const listAll = async (query: LedgerQuery & PaginationQuery) => {
	const pagination = getPagination(query);
	const where = ledgerWhere(query);

	const [rows, total] = await Promise.all([
		prisma.payment.findMany({
			where,
			orderBy: { createdAt: "desc" },
			skip: pagination.skip,
			take: pagination.take,
			select: {
				id: true,
				transactionId: true,
				amount: true,
				currency: true,
				status: true,
				gateway: true,
				paidAt: true,
				createdAt: true,
				user: { select: { id: true, name: true, email: true } },
				serviceRequest: {
					select: {
						id: true,
						referenceNo: true,
						serviceType: { select: { id: true, name: true } },
					},
				},
				refund: { select: { status: true, amount: true, processedAt: true } },
			},
		}),
		prisma.payment.count({ where }),
	]);

	return {
		items: rows.map((row) => ({
			...row,
			amount: money(row.amount),
			refund: row.refund ? { ...row.refund, amount: money(row.refund.amount) } : null,
		})),
		meta: buildMeta(pagination, total),
	};
};

/** `SUM` and `COUNT` for one status inside the current filter. */
const totalFor = async (where: Prisma.PaymentWhereInput, status: PaymentStatus) => {
	const row = await prisma.payment.aggregate({
		where: { ...where, status },
		_sum: { amount: true },
		_count: { _all: true },
	});
	return { count: row._count._all, amount: money(row._sum.amount) };
};

/**
 * The books.
 *
 * Three questions are being asked at once and they are not the same question,
 * so they stay three figures rather than collapsing into one called "revenue":
 *
 *   collected  what settled inside the filter
 *   refunded   what went back out — which does not cancel a collection, because
 *              a refund is usually raised against an older payment
 *   net        collected minus refunded, the only figure that answers what the
 *              city is actually holding
 *
 * `today`, `month` and `allTime` ignore the filter on purpose. They are the
 * constants at the top of the page, and a figure labelled "today" that quietly
 * obeyed a date range would be a lie on a page whose whole job is money.
 */
export const summary = async (query: Omit<LedgerQuery, "status">) => {
	const where = ledgerWhere(query);

	const dayStart = new Date();
	dayStart.setUTCHours(0, 0, 0, 0);
	const monthStart = new Date();
	monthStart.setUTCDate(1);
	monthStart.setUTCHours(0, 0, 0, 0);
	const settled = (gte: Date): Prisma.PaymentWhereInput => ({ paidAt: { gte } });

	// The series covers the filtered range, or the last 30 days when there is
	// no range — an empty chart on first open would say nothing at all.
	const range = dateRange(query.from, query.to);
	const seriesFrom = range?.gte ?? new Date(Date.now() - 29 * 86_400_000);
	const seriesTo = range?.lte ?? new Date();

	/*
	  Grouped by day in SQL. Prisma cannot group by a truncated date, and
	  pulling every settled payment into Node to bucket it is the kind of query
	  that is fine against seed data and falls over in year two. The join is
	  inner, which drops nothing: `serviceRequestId` is required on Payment.

	  The free-text search is deliberately NOT applied here. It narrows the
	  table — searching a payer's name and watching the revenue chart drop to
	  one bar would be a chart that answers a question nobody asked.
	*/
	const conditions = [
		Prisma.sql`p."status" = 'SUCCESS'`,
		Prisma.sql`p."paidAt" IS NOT NULL`,
		Prisma.sql`p."paidAt" >= ${seriesFrom}`,
		Prisma.sql`p."paidAt" <= ${seriesTo}`,
	];
	if (query.serviceTypeId) {
		conditions.push(Prisma.sql`sr."serviceTypeId" = ${query.serviceTypeId}`);
	}

	const [collected, pending, failed, cancelled, refunded, today, month, all, byRequest, daily] =
		await Promise.all([
			totalFor(where, "SUCCESS"),
			totalFor(where, "PENDING"),
			totalFor(where, "FAILED"),
			totalFor(where, "CANCELLED"),
			totalFor(where, "REFUNDED"),
			totalFor(settled(dayStart), "SUCCESS"),
			totalFor(settled(monthStart), "SUCCESS"),
			totalFor({}, "SUCCESS"),
			prisma.payment.groupBy({
				by: ["serviceRequestId"],
				where: { ...where, status: "SUCCESS" },
				_sum: { amount: true },
				_count: { _all: true },
			}),
			prisma.$queryRaw<{ day: Date; amount: Prisma.Decimal; count: bigint }[]>`
				SELECT date_trunc('day', p."paidAt") AS day,
				       SUM(p."amount")               AS amount,
				       COUNT(*)                      AS count
				FROM "Payment" p
				JOIN "ServiceRequest" sr ON sr."id" = p."serviceRequestId"
				WHERE ${Prisma.join(conditions, " AND ")}
				GROUP BY 1
				ORDER BY 1 ASC
			`,
		]);

	// The service type hangs off the request, not the payment, so the grouped
	// rows are resolved through one lookup rather than an N+1.
	const requestIds = byRequest.map((row) => row.serviceRequestId);
	const requests = requestIds.length
		? await prisma.serviceRequest.findMany({
				where: { id: { in: requestIds } },
				select: { id: true, serviceType: { select: { id: true, name: true } } },
			})
		: [];
	const typeOf = new Map(requests.map((r) => [r.id, r.serviceType]));

	const perType = new Map<string, { serviceType: string; count: number; amount: Prisma.Decimal }>();
	for (const row of byRequest) {
		const type = typeOf.get(row.serviceRequestId);
		if (!type) continue;
		const entry = perType.get(type.id) ?? {
			serviceType: type.name,
			count: 0,
			amount: new Prisma.Decimal(0),
		};
		entry.count += row._count._all;
		entry.amount = entry.amount.plus(row._sum.amount ?? 0);
		perType.set(type.id, entry);
	}

	return {
		totals: {
			collected,
			pending,
			failed,
			cancelled,
			refunded,
			/* The only figure here that is arithmetic rather than a query, and it
			   is done in Decimal for the same reason the rest are strings. */
			net: money(new Prisma.Decimal(collected.amount).minus(refunded.amount)),
		},
		today,
		month,
		allTime: all,
		byServiceType: [...perType.entries()]
			.map(([serviceTypeId, entry]) => ({
				serviceTypeId,
				serviceType: entry.serviceType,
				count: entry.count,
				amount: entry.amount.toFixed(2),
			}))
			.sort((a, b) => Number(b.amount) - Number(a.amount)),
		daily: daily.map((row) => ({
			date: row.day.toISOString().slice(0, 10),
			count: Number(row.count),
			amount: money(row.amount),
		})),
	};
};

/** Streams in pages, so a 50k-row ledger never sits in memory. */
export const streamLedgerCsv = async (
	query: LedgerQuery,
	write: (chunk: string) => void,
): Promise<void> => {
	const where = ledgerWhere(query);

	write(
		"transactionId,status,amount,currency,paidAt,createdAt,payer,email,reference,serviceType,refundStatus,refundAmount\n",
	);

	const escapeCsv = (value: unknown) => {
		const s = value === null || value === undefined ? "" : String(value);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};

	const pageSize = 500;
	let cursor: string | undefined;

	for (;;) {
		const rows = await prisma.payment.findMany({
			where,
			take: pageSize,
			...(cursor && { skip: 1, cursor: { id: cursor } }),
			orderBy: { id: "asc" },
			select: {
				id: true,
				transactionId: true,
				status: true,
				amount: true,
				currency: true,
				paidAt: true,
				createdAt: true,
				user: { select: { name: true, email: true } },
				serviceRequest: {
					select: { referenceNo: true, serviceType: { select: { name: true } } },
				},
				refund: { select: { status: true, amount: true } },
			},
		});

		if (!rows.length) break;

		for (const r of rows) {
			write(
				`${[
					r.transactionId,
					r.status,
					money(r.amount),
					r.currency,
					r.paidAt?.toISOString() ?? "",
					r.createdAt.toISOString(),
					r.user.name,
					r.user.email,
					r.serviceRequest?.referenceNo ?? "",
					r.serviceRequest?.serviceType.name ?? "",
					r.refund?.status ?? "",
					r.refund ? money(r.refund.amount) : "",
				]
					.map(escapeCsv)
					.join(",")}\n`,
			);
		}

		if (rows.length < pageSize) break;
		cursor = rows[rows.length - 1]?.id;
	}
};
