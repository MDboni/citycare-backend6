import type { Request, Response } from "express";
import type { SettingKey } from "@/lib/settings.js";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams, validatedQuery } from "@/middlewares/validateRequest.js";
import * as AdminService from "@/modules/admin/admin.service.js";
import type {
	AuditLogsQuery,
	CsvReportQuery,
	ListUsersQuery,
	SecurityEventsQuery,
} from "@/modules/admin/admin.validation.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import * as ComplaintService from "@/modules/complaint/complaint.service.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

type AdminActor = Actor & { isSuperAdmin: boolean };

const toActor = (req: Request): AdminActor => {
	const u = requireUser(req);
	return {
		id: u.id,
		role: u.role,
		departmentId: u.departmentId,
		email: u.email,
		name: u.name,
		isSuperAdmin: u.isSuperAdmin,
	};
};

export const listUsers = catchAsync(async (req: Request, res: Response) => {
	const { items, meta } = await AdminService.listUsers(validatedQuery<ListUsersQuery>(req));
	sendResponse(res, { message: "Users retrieved", data: items, meta });
});

export const createOfficer = catchAsync(async (req: Request, res: Response) => {
	const data = await AdminService.createOfficer(req.body, toActor(req), toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Officer created", data });
});

export const updateRole = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await AdminService.updateRole(id, req.body.role, toActor(req), toCtx(req));
	sendResponse(res, { message: "Role updated", data });
});

export const updateStatus = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await AdminService.updateStatus(
		id,
		req.body.status,
		req.body.reason,
		toActor(req),
		toCtx(req),
	);
	sendResponse(res, { message: "Status updated", data });
});

export const forceLogout = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await AdminService.forceLogout(id, toActor(req), toCtx(req));
	sendResponse(res, { message: "Sessions revoked", data });
});

export const createAdmin = catchAsync(async (req: Request, res: Response) => {
	const data = await AdminService.createAdmin(req.body, toActor(req), toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Admin created", data });
});

export const removeAdmin = catchAsync(async (req: Request, res: Response) => {
	const { id } = validatedParams<{ id: string }>(req);
	const data = await AdminService.removeAdmin(id, toActor(req), toCtx(req));
	sendResponse(res, { message: data.message });
});

export const restore = catchAsync(async (req: Request, res: Response) => {
	const { entity, id } = validatedParams<{
		entity: "complaint" | "user" | "category" | "department";
		id: string;
	}>(req);
	const data = await AdminService.restore(entity, id, toActor(req), toCtx(req));
	sendResponse(res, { message: "Record restored", data });
});

export const dashboardStats = catchAsync(async (_req: Request, res: Response) => {
	const data = await AdminService.dashboardStats();
	sendResponse(res, { message: "Dashboard stats retrieved", data });
});

export const auditLogs = catchAsync(async (req: Request, res: Response) => {
	const { items, meta } = await AdminService.auditLogs(
		validatedQuery<AuditLogsQuery>(req),
		toActor(req),
	);
	sendResponse(res, { message: "Audit logs retrieved", data: items, meta });
});

export const securityEvents = catchAsync(async (req: Request, res: Response) => {
	const { items, meta } = await AdminService.securityEvents(
		validatedQuery<SecurityEventsQuery>(req),
	);
	sendResponse(res, { message: "Security events retrieved", data: items, meta });
});

export const slaReport = catchAsync(async (_req: Request, res: Response) => {
	const data = await AdminService.slaReport();
	sendResponse(res, { message: "SLA report retrieved", data });
});

/** Streamed: the response starts before the last row has been read. */
export const complaintsCsv = catchAsync(async (req: Request, res: Response) => {
	res.setHeader("Content-Type", "text/csv; charset=utf-8");
	res.setHeader("Content-Disposition", 'attachment; filename="complaints.csv"');

	await AdminService.streamComplaintsCsv(validatedQuery<CsvReportQuery>(req), (chunk) => {
		res.write(chunk);
	});

	res.end();
});

export const listSettings = catchAsync(async (_req: Request, res: Response) => {
	const data = await AdminService.listSettings();
	sendResponse(res, { message: "Settings retrieved", data });
});

export const updateSetting = catchAsync(async (req: Request, res: Response) => {
	const { key } = validatedParams<{ key: SettingKey }>(req);
	const data = await AdminService.updateSetting(key, req.body.value, toActor(req), toCtx(req));
	sendResponse(res, { message: "Setting updated", data });
});

export const officerStats = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.listOfficerStats(requireUser(req).id);
	sendResponse(res, { message: "Officer stats retrieved", data });
});
