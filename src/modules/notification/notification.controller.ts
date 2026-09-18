import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams, validatedQuery } from "@/middlewares/validateRequest.js";
import * as NotificationService from "@/modules/notification/notification.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const list = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<{ page?: number; limit?: number; unread?: boolean }>(req);
	const { items, meta } = await NotificationService.list(requireUser(req).id, query);
	sendResponse(res, { message: "Notifications retrieved", data: items, meta });
});

export const markRead = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await NotificationService.markRead(requireUser(req).id, id);
	sendResponse(res, { message: "Notification marked as read", data });
});

export const markAllRead = catchAsync(async (req: Request, res: Response) => {
	const data = await NotificationService.markAllRead(requireUser(req).id);
	sendResponse(res, { message: "All notifications marked as read", data });
});
