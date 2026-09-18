import Redis from "ioredis";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";

/**
 * Redis holds pending signups, OTPs, counters, the JWT denylist and the cache.
 * It is deliberately NOT a hard dependency: if Redis is down the API keeps
 * serving (cache falls through to the database, limiters fall back to memory).
 * Only the OTP flows genuinely need it.
 */
const buildClient = (): Redis => {
	const options = {
		lazyConnect: true,
		maxRetriesPerRequest: 2,
		enableOfflineQueue: false,
		connectTimeout: 10_000,
		retryStrategy: (times: number) => Math.min(times * 500, 5_000),
	} as const;

	if (env.REDIS_URL) return new Redis(env.REDIS_URL, options);

	return new Redis({
		...options,
		host: env.REDIS_HOST || "127.0.0.1",
		port: env.REDIS_PORT,
		...(env.REDIS_USERNAME && { username: env.REDIS_USERNAME }),
		...(env.REDIS_PASSWORD && { password: env.REDIS_PASSWORD }),
	});
};

export const redis = buildClient();

let warned = false;
redis.on("error", (err: Error) => {
	// One warning per outage window is enough; a reconnect loop must not spam.
	if (!warned) {
		warned = true;
		logger.warn({ err: err.message }, "Redis unavailable — caching and OTP flows are degraded");
		setTimeout(() => {
			warned = false;
		}, 30_000).unref();
	}
});

redis.on("ready", () => logger.info("Redis connected"));

export const connectRedis = async (): Promise<boolean> => {
	try {
		if (redis.status === "ready" || redis.status === "connecting") return true;
		await redis.connect();
		return true;
	} catch (err) {
		logger.warn({ err: (err as Error).message }, "Redis connection failed at startup");
		return false;
	}
};

/** True when a command can realistically be sent right now. */
export const redisReady = (): boolean => redis.status === "ready";

/** Never let a Redis hiccup turn into a 500. */
export const safeRedis = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
	try {
		return await fn();
	} catch {
		return fallback;
	}
};
