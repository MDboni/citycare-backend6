import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams } from "@/middlewares/validateRequest.js";
import * as ServiceTypeService from "@/modules/serviceType/serviceType.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const list = catchAsync(async (_req: Request, res: Response) => {
	const data = await ServiceTypeService.list();
	sendResponse(res, { message: "Service types retrieved", data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await ServiceTypeService.create(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Service type created", data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await ServiceTypeService.update(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Service type updated", data });
});
