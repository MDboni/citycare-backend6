import type { Request } from "express";

/**
 * Everything a service needs to know about the caller. Services never receive
 * `req` or `res` — controllers translate the request into this object.
 */
export type Ctx = {
	ip: string;
	ua: string;
	requestId?: string;
};

export const toCtx = (req: Request): Ctx => ({
	ip: req.ip ?? "unknown",
	ua: (req.headers["user-agent"] ?? "unknown").toString().slice(0, 512),
	// pino-http widens `req.id`; the middleware always sets a string.
	requestId: String(req.id),
});

/** Shape the audit helper expects. */
export const toAuditCtx = (ctx: Ctx) => ({ ip: ctx.ip, userAgent: ctx.ua });
