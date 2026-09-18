import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams } from "@/middlewares/validateRequest.js";
import * as CategoryService from "@/modules/category/category.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const list = catchAsync(async (_req: Request, res: Response) => {
	const data = await CategoryService.list();
	sendResponse(res, { message: "Categories retrieved", data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await CategoryService.create(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Category created", data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await CategoryService.update(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Category updated", data });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await CategoryService.softDelete(id, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: data.message });
});
