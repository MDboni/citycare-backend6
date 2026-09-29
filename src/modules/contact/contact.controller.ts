import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams, validatedQuery } from "@/middlewares/validateRequest.js";
import * as ContactService from "@/modules/contact/contact.service.js";
import type { ListContactMessagesQuery } from "@/modules/contact/contact.validation.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await ContactService.create(req.body, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Message received", data });
});

export const list = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListContactMessagesQuery>(req);
	const { items, meta } = await ContactService.list(query);
	sendResponse(res, { message: "Messages retrieved", data: { items }, meta });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await ContactService.getById(id);
	sendResponse(res, { message: "Message retrieved", data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await ContactService.update(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Message updated", data });
});
