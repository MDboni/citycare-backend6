import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import * as ZoneService from "@/modules/zone/zone.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const list = catchAsync(async (_req: Request, res: Response) => {
	const data = await ZoneService.list();
	sendResponse(res, { message: "Zones retrieved", data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await ZoneService.create(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Zone created", data });
});
