import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams } from "@/middlewares/validateRequest.js";
import * as WardService from "@/modules/ward/ward.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const list = catchAsync(async (_req: Request, res: Response) => {
	const data = await WardService.list();
	sendResponse(res, { message: "Wards retrieved", data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await WardService.create(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Ward created", data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await WardService.update(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Ward updated", data });
});
