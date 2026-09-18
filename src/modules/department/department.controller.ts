import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams } from "@/middlewares/validateRequest.js";
import * as DepartmentService from "@/modules/department/department.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const list = catchAsync(async (_req: Request, res: Response) => {
	const data = await DepartmentService.list();
	sendResponse(res, { message: "Departments retrieved", data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await DepartmentService.create(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Department created", data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await DepartmentService.update(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Department updated", data });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await DepartmentService.softDelete(id, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: data.message });
});
