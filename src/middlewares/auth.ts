import type { RequestHandler } from "express";
import { redis } from "@/config/redis.js";
import { CACHE_TTL, cached } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { verifyAccessToken } from "@/utils/jwt.js";

const AUTH_USER_SELECT = {
	id: true,
	name: true,
	email: true,
	role: true,
	status: true,
	departmentId: true,
	isSuperAdmin: true,
	passwordChangedAt: true,
} as const;

/**
 * Five independent checks, because a signed token alone is not enough:
 *   1. signature + issuer + audience + HS256 only
 *   2. the token id is not on the logout denylist
 *   3. the session still exists and is not revoked
 *   4. the user still exists and is not blocked or soft-deleted
 *   5. the token predates neither a password change nor a role change
 */
export const auth: RequestHandler = catchAsync(async (req, _res, next) => {
	const header = req.headers.authorization;
	const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

	if (!token) {
		throw new ApiError(401, "Unauthorized", [
			{ code: "TOKEN_MISSING", message: "Bearer token missing" },
		]);
	}

	const payload = verifyAccessToken(token);

	const denied = await redis.exists(`jwt:deny:${payload.jti}`).catch(() => 0);
	if (denied) {
		throw new ApiError(401, "Token revoked", [{ code: "TOKEN_REVOKED", message: "Token revoked" }]);
	}

	const session = await cached(`sess:${payload.sid}`, CACHE_TTL.session, () =>
		prisma.session.findFirst({
			where: { id: payload.sid, revokedAt: null, expiresAt: { gt: new Date() } },
			select: { id: true },
		}),
	);
	if (!session) {
		throw new ApiError(401, "Session expired", [
			{ code: "TOKEN_EXPIRED", message: "Session expired" },
		]);
	}

	const user = await prisma.user.findFirst({
		where: { id: payload.sub, deletedAt: null },
		select: AUTH_USER_SELECT,
	});

	if (!user) throw new ApiError(401, "User no longer exists");
	if (user.status === "BLOCKED") {
		throw new ApiError(403, "Account is blocked", [
			{ code: "ACCOUNT_BLOCKED", message: "Account is blocked" },
		]);
	}
	if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
		throw new ApiError(401, "Password changed, login again");
	}
	if (user.role !== payload.role) throw new ApiError(401, "Role changed, login again");

	req.user = user;
	req.sessionId = payload.sid;
	req.token = { jti: payload.jti, exp: payload.exp };
	next();
});

/**
 * For routes that behave differently when signed in but must not 401
 * (public complaint tracking, for example).
 */
export const optionalAuth: RequestHandler = catchAsync(async (req, res, next) => {
	if (!req.headers.authorization) return next();
	return auth(req, res, next);
});

/** Controllers call this instead of trusting `req.user` to be present. */
export const requireUser = (req: { user?: Express.User }): Express.User => {
	if (!req.user) throw new ApiError(401, "Unauthorized", [{ code: "TOKEN_MISSING" }]);
	return req.user;
};
