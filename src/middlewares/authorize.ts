import type { RequestHandler } from "express";
import type { Role } from "@/generated/prisma/enums.js";
import { ApiError } from "@/utils/ApiError.js";

/**
 * Role guard — the first of two layers. The second is the ownership check
 * inside every service method that takes an `:id`.
 */
export const authorize =
	(...roles: Role[]): RequestHandler =>
	(req, _res, next) => {
		if (!req.user) {
			throw new ApiError(401, "Unauthorized", [{ code: "TOKEN_MISSING" }]);
		}
		if (!roles.includes(req.user.role)) {
			throw new ApiError(403, "Forbidden: insufficient role", [
				{ code: "FORBIDDEN_ROLE", message: "Forbidden: insufficient role" },
			]);
		}
		next();
	};

/**
 * Super admin is not a fourth role — it is an ADMIN carrying `isSuperAdmin`,
 * read fresh from the database by the auth middleware on every request.
 */
export const superAdminOnly: RequestHandler = (req, _res, next) => {
	if (!req.user) {
		throw new ApiError(401, "Unauthorized", [{ code: "TOKEN_MISSING" }]);
	}
	if (req.user.role !== "ADMIN" || !req.user.isSuperAdmin) {
		throw new ApiError(403, "Forbidden: super admin only", [
			{ code: "SUPER_ADMIN_ONLY", message: "Forbidden: super admin only" },
		]);
	}
	next();
};
