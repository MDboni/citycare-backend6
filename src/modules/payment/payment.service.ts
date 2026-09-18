import crypto from "node:crypto";
import SSLCommerzPayment from "sslcommerz-lts";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { sendReceiptEmail } from "@/lib/mailer.js";
import { paymentCounter } from "@/lib/metrics.js";
import { prisma } from "@/lib/prisma.js";
import { generateReceipt } from "@/lib/receipt.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import { dispatchEmail, notify } from "@/modules/notification/notification.service.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { buildMeta, getPagination, type PaginationQuery } from "@/utils/pagination.js";

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
		const receiptUrl = await generateReceipt({
			transactionId: tranId,
			referenceNo: payment.serviceRequest.referenceNo,
			serviceName: payment.serviceRequest.serviceType.name,
			amount: String(payment.amount),
			currency: payment.currency,
			payerName: payment.user.name,
			payerEmail: payment.user.email,
			paidAt: new Date(),
		});
		await sendReceiptEmail(payment.user.email, {
			transactionId: tranId,
			amount: String(payment.amount),
			serviceName: payment.serviceRequest.serviceType.name,
			...(receiptUrl && { receiptUrl }),
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
				serviceRequest: { select: { referenceNo: true, serviceType: { select: { name: true } } } },
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
