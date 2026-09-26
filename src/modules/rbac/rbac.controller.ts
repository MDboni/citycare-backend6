import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams } from "@/middlewares/validateRequest.js";
import * as RbacService from "@/modules/rbac/rbac.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

// ── permissions ─────────────────────────────────────────────────────────────

export const listPermissions = catchAsync(async (req: Request, res: Response) => {
	const data = await RbacService.listPermissions(
		req.query as { category?: string; search?: string },
	);
	sendResponse(res, { message: "Permissions retrieved", data });
});

export const createPermission = catchAsync(async (req: Request, res: Response) => {
	const data = await RbacService.createPermission(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Permission created", data });
});

export const updatePermission = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await RbacService.updatePermission(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Permission updated", data });
});

export const deletePermission = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await RbacService.deletePermission(id, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: data.message });
});

// ── roles ───────────────────────────────────────────────────────────────────

export const listRoles = catchAsync(async (_req: Request, res: Response) => {
	const data = await RbacService.listRoles();
	sendResponse(res, { message: "Roles retrieved", data });
});

export const createRole = catchAsync(async (req: Request, res: Response) => {
	const data = await RbacService.createRole(req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Role created", data });
});

export const updateRole = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await RbacService.updateRole(id, req.body, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: "Role updated", data });
});

export const deleteRole = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await RbacService.deleteRole(id, requireUser(req).id, toCtx(req));
	sendResponse(res, { message: data.message });
});

// ── assignment ──────────────────────────────────────────────────────────────

export const getUserRoles = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await RbacService.getUserRoles(id);
	sendResponse(res, { message: "User roles retrieved", data });
});

export const assignUserRoles = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await RbacService.assignUserRoles(
		id,
		req.body.roleIds,
		requireUser(req).id,
		toCtx(req),
	);
	sendResponse(res, { message: "Roles assigned", data });
});

/**
 * Deliberately behind `auth` only and no permission of its own: a user must be
 * able to learn what they may do, or the console cannot decide what to render.
 */
export const myPermissions = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	const data = await RbacService.myPermissions(user.id, user.role, user.isSuperAdmin);
	sendResponse(res, { message: "Permissions retrieved", data });
});
