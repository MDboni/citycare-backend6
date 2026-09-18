import type { Request, Response } from "express";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams, validatedQuery } from "@/middlewares/validateRequest.js";
import type { Actor } from "@/modules/complaint/complaint.service.js";
import * as ComplaintService from "@/modules/complaint/complaint.service.js";
import type { ListComplaintsQuery } from "@/modules/complaint/complaint.validation.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

/** Services take a plain actor, never `req`. */
const toActor = (req: Request): Actor => {
	const user = requireUser(req);
	return {
		id: user.id,
		role: user.role,
		departmentId: user.departmentId,
		email: user.email,
		name: user.name,
	};
};

const idOf = (req: Request) => validatedParams<{ id: string }>(req).id;

export const create = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.create(req.body, toActor(req), toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Complaint submitted successfully", data });
});

export const list = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListComplaintsQuery>(req);
	const { items, meta } = await ComplaintService.list(query, toActor(req));
	sendResponse(res, { message: "Complaints retrieved", data: items, meta });
});

export const listMine = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListComplaintsQuery>(req);
	const { items, meta } = await ComplaintService.listMine(query, toActor(req));
	sendResponse(res, { message: "Complaints retrieved", data: items, meta });
});

export const listAssigned = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListComplaintsQuery>(req);
	const { items, meta } = await ComplaintService.listAssigned(query, toActor(req));
	sendResponse(res, { message: "Assigned complaints retrieved", data: items, meta });
});

export const search = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<ListComplaintsQuery & { q: string }>(req);
	const { items, meta } = await ComplaintService.search(query.q, query, toActor(req));
	sendResponse(res, { message: "Search results", data: items, meta });
});

export const nearby = catchAsync(async (req: Request, res: Response) => {
	const query = validatedQuery<{ lat: number; lng: number; radiusKm: number; limit?: number }>(req);
	const data = await ComplaintService.nearby(query);
	sendResponse(res, { message: "Nearby complaints retrieved", data });
});

export const track = catchAsync(async (req: Request, res: Response) => {
	const { trackingId } = validatedParams<{ trackingId: string }>(req);
	const data = await ComplaintService.track(trackingId);
	sendResponse(res, { message: "Complaint status retrieved", data });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.getById(idOf(req), toActor(req));
	sendResponse(res, { message: "Complaint retrieved", data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.update(idOf(req), req.body, toActor(req), toCtx(req));
	sendResponse(res, { message: "Complaint updated", data });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.softDelete(idOf(req), toActor(req), toCtx(req));
	sendResponse(res, { message: data.message });
});

export const changeStatus = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.changeStatus(
		idOf(req),
		req.body.status,
		req.body.note,
		toActor(req),
		toCtx(req),
	);
	sendResponse(res, { message: `Status changed to ${req.body.status}`, data });
});

export const assign = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.assign(idOf(req), req.body, toActor(req), toCtx(req));
	sendResponse(res, { message: "Complaint assigned", data });
});

export const cancel = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.cancel(idOf(req), req.body?.note, toActor(req), toCtx(req));
	sendResponse(res, { message: "Complaint cancelled", data });
});

export const reopen = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.reopen(idOf(req), req.body?.note, toActor(req), toCtx(req));
	sendResponse(res, { message: "Complaint reopened", data });
});

export const history = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.history(idOf(req), toActor(req));
	sendResponse(res, { message: "History retrieved", data });
});

export const addAttachment = catchAsync(async (req: Request, res: Response) => {
	if (!req.file) {
		throw new ApiError(400, "Validation failed", [
			{ field: "file", code: "VALIDATION_ERROR", message: "A file is required" },
		]);
	}
	const data = await ComplaintService.addAttachment(
		idOf(req),
		req.file,
		req.body?.kind,
		toActor(req),
	);
	sendResponse(res, { statusCode: 201, message: "Attachment uploaded", data });
});

export const addComment = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.addComment(idOf(req), req.body, toActor(req));
	sendResponse(res, { statusCode: 201, message: "Comment added", data });
});

export const listComments = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.listComments(idOf(req), toActor(req));
	sendResponse(res, { message: "Comments retrieved", data });
});

export const upvote = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.upvote(idOf(req), toActor(req));
	sendResponse(res, { statusCode: 201, message: "Upvoted", data });
});

export const feedback = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.feedback(idOf(req), req.body, toActor(req), toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Thanks for your feedback", data });
});

export const officerStats = catchAsync(async (req: Request, res: Response) => {
	const data = await ComplaintService.listOfficerStats(requireUser(req).id);
	sendResponse(res, { message: "Officer stats retrieved", data });
});
