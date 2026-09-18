import type { Request, Response } from "express";
import { env } from "@/config/env.js";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams, validatedQuery } from "@/middlewares/validateRequest.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import * as PaymentService from "@/modules/payment/payment.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

const toActor = (req: Request): Actor => {
	const u = requireUser(req);
	return { id: u.id, role: u.role, departmentId: u.departmentId, email: u.email, name: u.name };
};

const clientUrl = () => env.CLIENT_URL.split(",")[0];

export const initiate = catchAsync(async (req: Request, res: Response) => {
	const data = await PaymentService.initiate(
		requireUser(req).id,
		req.body.serviceRequestId,
		toCtx(req),
	);
	sendResponse(res, { statusCode: 201, message: "Payment session created", data });
});

/**
 * Gateway callbacks are public form posts. Every one is recorded raw first,
 * then verified against the gateway's own validation API.
 */
export const success = catchAsync(async (req: Request, res: Response) => {
	const payload = { ...req.body, ...req.query } as Record<string, unknown>;
	await PaymentService.recordEvent("SUCCESS_CALLBACK", payload, req.ip ?? "unknown");

	const tranId = String(payload.tran_id ?? "");
	const valId = String(payload.val_id ?? "");
	await PaymentService.confirm(tranId, valId);

	res.redirect(
		`${clientUrl()}/payments/result?status=success&tranId=${encodeURIComponent(tranId)}`,
	);
});

export const fail = catchAsync(async (req: Request, res: Response) => {
	const payload = { ...req.body, ...req.query } as Record<string, unknown>;
	await PaymentService.recordEvent("FAIL_CALLBACK", payload, req.ip ?? "unknown");

	const tranId = String(payload.tran_id ?? "");
	await PaymentService.markTerminal(tranId, "FAILED");

	res.redirect(`${clientUrl()}/payments/result?status=failed&tranId=${encodeURIComponent(tranId)}`);
});

export const cancel = catchAsync(async (req: Request, res: Response) => {
	const payload = { ...req.body, ...req.query } as Record<string, unknown>;
	await PaymentService.recordEvent("CANCEL_CALLBACK", payload, req.ip ?? "unknown");

	const tranId = String(payload.tran_id ?? "");
	await PaymentService.markTerminal(tranId, "CANCELLED");

	res.redirect(
		`${clientUrl()}/payments/result?status=cancelled&tranId=${encodeURIComponent(tranId)}`,
	);
});

/** Server-to-server webhook: answers JSON, never a redirect. */
export const ipn = catchAsync(async (req: Request, res: Response) => {
	const payload = { ...req.body, ...req.query } as Record<string, unknown>;
	await PaymentService.recordEvent("IPN", payload, req.ip ?? "unknown");

	const tranId = String(payload.tran_id ?? "");
	const valId = String(payload.val_id ?? "");
	await PaymentService.confirm(tranId, valId);

	sendResponse(res, { message: "IPN processed", data: { transactionId: tranId } });
});

export const listMine = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<{ page?: number; limit?: number }>(req);
	const { items, meta } = await PaymentService.listMine(requireUser(req).id, query);
	sendResponse(res, { message: "Payments retrieved", data: items, meta });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await PaymentService.getById(id, toActor(req));
	sendResponse(res, { message: "Payment retrieved", data });
});

export const requestRefund = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await PaymentService.requestRefund(id, req.body.reason, toActor(req), toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Refund requested", data });
});

export const approveRefund = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await PaymentService.approveRefund(id, toActor(req), toCtx(req));
	sendResponse(res, { message: "Refund processed", data });
});
