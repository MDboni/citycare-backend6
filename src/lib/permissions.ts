import { redis } from "@/config/redis.js";
import type { Role } from "@/generated/prisma/enums.js";
import { cached, invalidate } from "@/lib/cache.js";
import { prisma } from "@/lib/prisma.js";

const key = (userId: string) => `perm:${userId}`;

/** Short, because a revoked permission should stop working in seconds. */
const PERMISSION_TTL = 60;

/**
 * Every permission code this user effectively holds.
 *
 * Two sources, in order:
 *   1. the roles explicitly assigned on Settings → Access
 *   2. failing that, the system role mirroring their account type
 *
 * Step 2 is what makes this safe to introduce: a staff member nobody has
 * touched yet keeps exactly the access their enum role always gave them, so
 * turning RBAC on changes nothing until someone deliberately changes it.
 */
export const getUserPermissions = async (userId: string, role: Role): Promise<Set<string>> => {
	const codes = await cached(key(userId), PERMISSION_TTL, async () => {
		const assigned = await prisma.userAccessRole.findMany({
			where: { userId },
			select: {
				role: {
					select: { permissions: { select: { permission: { select: { code: true } } } } },
				},
			},
		});

		if (assigned.length > 0) {
			return assigned.flatMap((a) => a.role.permissions.map((p) => p.permission.code));
		}

		const fallback = await prisma.accessRole.findUnique({
			where: { mirrors: role },
			select: { permissions: { select: { permission: { select: { code: true } } } } },
		});

		return fallback?.permissions.map((p) => p.permission.code) ?? [];
	});

	return new Set(codes);
};

/** Drop one user's cached set — after their role assignments change. */
export const invalidateUserPermissions = (userId: string) => invalidate(key(userId));

/**
 * Drop everyone's.
 *
 * Editing a role's permissions changes what every holder of that role may do,
 * and the holders are not necessarily known here (the system-role fallback has
 * no rows at all). Scanning the small `perm:*` keyspace is cheaper than being
 * wrong for a minute about who can approve a refund.
 */
export const invalidateAllPermissions = async (): Promise<void> => {
	try {
		const keys = await redis.keys("perm:*");
		if (keys.length) await redis.del(...keys);
	} catch {
		// The keys expire in a minute anyway; a failed sweep is not an error.
	}
};
