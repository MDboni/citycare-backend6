import type { Request, Response } from "express";
import rateLimit, { type Options } from "express-rate-limit";

/**
 * Every limiter answers with the standard error envelope — a 429 must not be
 * the one response shape a client cannot parse.
 */
const limitHandler = (code: string, message: string) => (req: Request, res: Response) => {
	res.status(429).json({
		success: false,
		message,
		errors: [{ code, message }],
		requestId: req.id,
	});
};

const base = (
	windowMs: number,
	max: number,
	code: string,
	message: string,
	extra: Partial<Options> = {},
) =>
	rateLimit({
		windowMs,
		limit: max,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		handler: limitHandler(code, message),
		// The in-memory store is intentional: Redis is a soft dependency, and a
		// per-instance limiter is better than no limiter at all.
		...extra,
	});

/** 100 requests / 15 min per IP across the whole API. */
export const globalLimiter = base(
	15 * 60_000,
	100,
	"RATE_LIMITED",
	"Too many requests, please slow down",
);

/** Register, login, resend-otp, forgot-password: 5 / 15 min per IP. */
export const authLimiter = base(
	15 * 60_000,
	5,
	"RATE_LIMITED",
	"Too many attempts, try again in 15 minutes",
	{ skipSuccessfulRequests: false },
);

/** Payment initiate: 10 / hour per IP. */
export const paymentLimiter = base(
	60 * 60_000,
	10,
	"RATE_LIMITED",
	"Too many payment attempts, try again later",
);

/** Gateway callbacks are public, so they get their own tighter budget. */
export const callbackLimiter = base(60_000, 20, "RATE_LIMITED", "Too many callback requests");

/** Admin routes: 30 / min. */
export const adminLimiter = base(60_000, 30, "RATE_LIMITED", "Too many admin requests");
