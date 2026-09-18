import type { Response } from "express";

export type ResponseMeta = {
	page?: number;
	limit?: number;
	total?: number;
	totalPages?: number;
	[key: string]: unknown;
};

export type SuccessPayload<T> = {
	statusCode?: number;
	message: string;
	data?: T;
	meta?: ResponseMeta;
};

/**
 * The one and only success envelope:
 * { success, message, data, meta? }
 */
export const sendResponse = <T>(res: Response, p: SuccessPayload<T>): void => {
	res.status(p.statusCode ?? 200).json({
		success: true,
		message: p.message,
		data: p.data ?? null,
		...(p.meta && { meta: p.meta }),
	});
};
