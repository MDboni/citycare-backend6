import type { RequestHandler, Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { hashBody } from "@/utils/crypto.js";

const TTL_HOURS = 24;

/**
 * Optional `Idempotency-Key` support for the two endpoints that create money
 * or a public record: POST /payments/initiate and POST /complaints.
 *
 *   same key + same body  -> the stored response is replayed
 *   same key + other body -> 422 IDEMPOTENCY_MISMATCH
 *   new key               -> run the handler, store what it answered
 *
 * Without the header the request behaves normally.
 */
export const idempotency = (endpoint: string): RequestHandler =>
	catchAsync(async (req, res, next) => {
		const header = req.headers["idempotency-key"];
		const key = Array.isArray(header) ? header[0] : header;
		if (!key || !req.user) return next();

		if (key.length > 255) {
			throw new ApiError(400, "Validation failed", [
				{ field: "Idempotency-Key", code: "VALIDATION_ERROR", message: "Key is too long" },
			]);
		}

		const userId = req.user.id;
		const requestHash = hashBody(req.body);
		const existing = await prisma.idempotencyKey.findUnique({
			where: { key_userId_endpoint: { key, userId, endpoint } },
		});

		if (existing && existing.expiresAt > new Date()) {
			if (existing.requestHash !== requestHash) {
				throw new ApiError(422, "Idempotency key was already used with a different body", [
					{ code: "IDEMPOTENCY_MISMATCH", message: "Key reused with a different payload" },
				]);
			}
			if (existing.responseBody !== null && existing.statusCode !== null) {
				res.setHeader("Idempotent-Replay", "true");
				res.status(existing.statusCode).json(existing.responseBody);
				return;
			}
		}

		await prisma.idempotencyKey.upsert({
			where: { key_userId_endpoint: { key, userId, endpoint } },
			create: {
				key,
				userId,
				endpoint,
				requestHash,
				expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000),
			},
			update: {
				requestHash,
				responseBody: undefined,
				statusCode: null,
				expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000),
			},
		});

		captureResponse(res, async (statusCode, body) => {
			if (statusCode >= 400) {
				// Only successful responses are worth replaying.
				await prisma.idempotencyKey
					.delete({ where: { key_userId_endpoint: { key, userId, endpoint } } })
					.catch(() => {});
				return;
			}
			await prisma.idempotencyKey
				.update({
					where: { key_userId_endpoint: { key, userId, endpoint } },
					data: { statusCode, responseBody: body as never },
				})
				.catch(() => {});
		});

		next();
	});

/** Hooks `res.json` once so the handler's own response can be stored. */
const captureResponse = (
	res: Response,
	onFinish: (statusCode: number, body: unknown) => Promise<void>,
): void => {
	const originalJson = res.json.bind(res);
	res.json = (body: unknown) => {
		void onFinish(res.statusCode, body);
		return originalJson(body);
	};
};
