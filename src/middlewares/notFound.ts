import type { RequestHandler } from "express";

/**
 * 404 uses the same envelope as every other error — a client parser must never
 * need a special case for "route not found".
 */
export const notFound: RequestHandler = (req, res) => {
	res.status(404).json({
		success: false,
		message: `Route ${req.method} ${req.originalUrl} not found`,
		errors: [{ code: "ROUTE_NOT_FOUND", message: "Route not found" }],
		requestId: req.id,
	});
};
