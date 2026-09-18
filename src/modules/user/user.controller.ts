import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import * as UserService from "@/modules/user/user.service.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

export const getMe = catchAsync(async (req: Request, res: Response) => {
	const data = await UserService.getMe(requireUser(req).id);
	sendResponse(res, { message: "Profile retrieved", data });
});

export const updateMe = catchAsync(async (req: Request, res: Response) => {
	const data = await UserService.updateMe(requireUser(req).id, req.body);
	sendResponse(res, { message: "Profile updated", data });
});

export const updateAvatar = catchAsync(async (req: Request, res: Response) => {
	if (!req.file) {
		throw new ApiError(400, "Validation failed", [
			{ field: "avatar", code: "VALIDATION_ERROR", message: "Avatar file is required" },
		]);
	}
	const data = await UserService.updateAvatar(requireUser(req).id, req.file);
	sendResponse(res, { message: "Avatar updated", data });
});

export const exportData = catchAsync(async (req: Request, res: Response) => {
	const data = await UserService.exportData(requireUser(req).id);
	res.setHeader("Content-Disposition", 'attachment; filename="citycare-export.json"');
	sendResponse(res, { message: "Data export ready", data });
});

export const deleteMe = catchAsync(async (req: Request, res: Response) => {
	const data = await UserService.deleteMe(requireUser(req).id, toCtx(req));
	sendResponse(res, { message: data.message });
});
