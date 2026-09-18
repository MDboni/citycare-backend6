import crypto from "node:crypto";
import type { RequestHandler } from "express";

const SAFE_ID = /^[\w.:-]{1,128}$/;

/**
 * Accepts an upstream X-Request-Id (validated, so a header cannot inject junk
 * into the log stream), otherwise mints one. Echoed back on every response and
 * repeated in every error body, so a user can quote it in a bug report.
 */
export const requestId: RequestHandler = (req, res, next) => {
	const incoming = req.headers["x-request-id"];
	const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

	req.id = candidate && SAFE_ID.test(candidate) ? candidate : crypto.randomUUID();
	res.setHeader("X-Request-Id", req.id);
	next();
};
