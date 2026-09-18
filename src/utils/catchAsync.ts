import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async handler so a rejected promise reaches the global error
 * handler instead of hanging the request. Controllers never use try/catch.
 */
export const catchAsync =
	(fn: RequestHandler): RequestHandler =>
	(req: Request, res: Response, next: NextFunction) => {
		Promise.resolve(fn(req, res, next)).catch(next);
	};
