import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams, validatedQuery } from "@/middlewares/validateRequest.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import * as SR from "@/modules/serviceRequest/serviceRequest.service.js";
import type { ListServiceRequestsQuery } from "@/modules/serviceRequest/serviceRequest.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

const toActor = (req: Request): Actor => {
	const u = requireUser(req);
	return { id: u.id, role: u.role, departmentId: u.departmentId, email: u.email, name: u.name };
};

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await SR.create(req.body, toActor(req), toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Service request submitted", data });
});

export const listMine = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListServiceRequestsQuery>(req);
	const { items, meta } = await SR.listMine(query, toActor(req));
	sendResponse(res, { message: "Service requests retrieved", data: items, meta });
});

export const list = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListServiceRequestsQuery>(req);
	const { items, meta } = await SR.list(query);
	sendResponse(res, { message: "Service requests retrieved", data: items, meta });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await SR.getById(id, toActor(req));
	sendResponse(res, { message: "Service request retrieved", data });
});

export const updateStatus = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await SR.updateStatus(id, req.body, toActor(req), toCtx(req));
	sendResponse(res, { message: "Service request updated", data });
});

export const addDocument = catchAsync(async (req: Request, res: Response) => {
	if (!req.file) {
		throw new ApiError(400, "Validation failed", [
			{ field: "document", code: "VALIDATION_ERROR", message: "A document file is required" },
		]);
	}
	const { id } = validatedParams<{ id: string }>(req);
	const data = await SR.addDocument(id, req.body.label, req.file, toActor(req));
	sendResponse(res, { statusCode: 201, message: "Document uploaded", data });
});

export const getDocument = catchAsync(async (req: Request, res: Response) => {
	const { id, docId } = validatedParams<{ id: string; docId: string }>(req);
	const data = await SR.getDocumentUrl(id, docId, toActor(req));
	sendResponse(res, { message: "Signed document link generated", data });
});
