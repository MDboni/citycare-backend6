import type { Role, UserStatus } from "@/generated/prisma/enums.js";

/**
 * The trimmed user the auth middleware attaches — a select whitelist, so a
 * password hash can never leak through `req.user`.
 *
 * `Express.User` (not a new property) is augmented on purpose: passport already
 * declares `Request.user?: Express.User`, and redeclaring it would conflict.
 */
declare global {
	namespace Express {
		interface User {
			id: string;
			name: string;
			email: string;
			role: Role;
			status: UserStatus;
			departmentId: string | null;
			isSuperAdmin: boolean;
			passwordChangedAt: Date | null;
		}

		interface Request {
			/** Correlation id, echoed back as the X-Request-Id header. */
			id: string;
			/** Session the access token belongs to (set by the auth middleware). */
			sessionId?: string;
			/** Claims of the presented access token — logout needs jti + exp. */
			token?: { jti: string; exp: number };
			/** Validated query/params, because Express 5 makes `req.query` read-only. */
			validated?: {
				query?: Record<string, unknown>;
				params?: Record<string, unknown>;
			};
		}
	}
}

export type AuthUser = Express.User;
