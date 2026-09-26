import type { RequestHandler } from "express";
import type { PermissionCode } from "@/config/permissions.js";
import type { Role } from "@/generated/prisma/enums.js";
import { getUserPermissions } from "@/lib/permissions.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";

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

/**
 * Permission guard — the fine-grained layer above `authorize`.
 *
 * `authorize` still answers "is this the right kind of account", because a
 * citizen must never reach a staff endpoint by being handed a role. This
 * answers "may this particular staff member do this particular thing", which
 * is the part an administrator can now change from Settings → Access.
 *
 * A super admin always passes. Without that, one bad save on the roles screen
 * would lock every administrator out of the screen that could undo it, and the
 * only way back would be psql.
 */
export const requirePermission = (...codes: PermissionCode[]): RequestHandler =>
	catchAsync(async (req, _res, next) => {
		if (!req.user) {
			throw new ApiError(401, "Unauthorized", [{ code: "TOKEN_MISSING" }]);
		}
		if (req.user.isSuperAdmin) return next();

		const granted = await getUserPermissions(req.user.id, req.user.role);
		if (!codes.some((code) => granted.has(code))) {
			throw new ApiError(403, "Forbidden: missing permission", [
				{
					code: "FORBIDDEN_PERMISSION",
					message: `Requires one of: ${codes.join(", ")}`,
				},
			]);
		}
		next();
	});
