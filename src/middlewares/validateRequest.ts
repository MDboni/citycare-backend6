import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { catchAsync } from "@/utils/catchAsync.js";

/**
 * Validates `{ body, query, params }` in one pass.
 *
 * Express 5 exposes `req.query` as a getter only, so the parsed query and
 * params are written to `req.validated` instead — controllers read them from
 * there and get coerced, whitelisted values.
 */
export const validateRequest = (schema: ZodType): RequestHandler =>
	catchAsync(async (req, _res, next) => {
		const parsed = (await schema.parseAsync({
			body: req.body,
			query: req.query,
			params: req.params,
		})) as {
			body?: unknown;
			query?: Record<string, unknown>;
			params?: Record<string, unknown>;
		};

		if (parsed.body !== undefined) req.body = parsed.body;
		req.validated = { query: parsed.query, params: parsed.params };
		next();
	});

/** Typed accessor for the validated query — avoids `as` noise in controllers. */
export const validatedQuery = <T>(req: { validated?: { query?: unknown } }): T =>
	(req.validated?.query ?? {}) as T;

export const validatedParams = <T>(req: { validated?: { params?: unknown } }): T =>
	(req.validated?.params ?? {}) as T;
