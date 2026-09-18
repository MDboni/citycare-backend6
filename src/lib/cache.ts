import { redis } from "@/config/redis.js";
import { logger } from "@/lib/logger.js";

/**
 * Read-through cache. A Redis outage must never break a request: on any Redis
 * error we simply serve from the database and skip the write-back.
 */
export const cached = async <T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> => {
	try {
		const hit = await redis.get(key);
		if (hit) {
			logger.debug({ key }, "cache hit");
			return JSON.parse(hit) as T;
		}
	} catch {
		// Redis down — fall through to the database.
	}

	const data = await fn();
	redis.set(key, JSON.stringify(data), "EX", ttl).catch(() => {});
	return data;
};

/** Drop one or more cache keys after a write. Failures are non-fatal. */
export const invalidate = async (...keys: string[]): Promise<void> => {
	if (!keys.length) return;
	try {
		await redis.del(...keys);
	} catch {
		// Cached data expires on its own; a failed invalidation is not an error.
	}
};

export const CACHE_KEYS = {
	categories: "categories:all",
	departments: "departments:all",
	wards: "wards:all",
	zones: "zones:all",
	serviceTypes: "servicetypes:all",
	adminStats: "admin:stats",
} as const;

export const CACHE_TTL = {
	masterData: 3600,
	stats: 60,
	session: 60,
} as const;

/** Every public master-data list, dropped in one call after any write. */
export const invalidateMasterData = () =>
	invalidate(
		CACHE_KEYS.categories,
		CACHE_KEYS.departments,
		CACHE_KEYS.wards,
		CACHE_KEYS.zones,
		CACHE_KEYS.serviceTypes,
	);
