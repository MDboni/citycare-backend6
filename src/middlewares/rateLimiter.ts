import type { Request, Response } from "express";
import rateLimit, {
	type IncrementResponse,
	MemoryStore,
	type Options,
	type Store,
} from "express-rate-limit";
import { type RedisReply, RedisStore } from "rate-limit-redis";
import { env, isTest } from "@/config/env.js";
import { redis } from "@/config/redis.js";
import { logger } from "@/lib/logger.js";

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

const sendCommand = (...args: string[]): Promise<RedisReply> =>
	redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>;

/**
 * Counting in Redis is only worth it when Redis is configured — and never in
 * tests, where a counter surviving between runs would fail today a suite that
 * passed yesterday.
 */
const useRedis = !isTest && Boolean(env.REDIS_URL || env.REDIS_HOST);

/**
 * Redis first, per-instance memory second.
 *
 * A serverless host answers each request from a short-lived instance, so an
 * in-memory counter starts near zero almost every time: the limiter looks
 * present and enforces nothing. Redis is the only place a count survives.
 *
 * Redis stays a soft dependency, though, as it is everywhere else here — if an
 * outage turned every request into a 500 the limiter would have become the
 * outage. So each call falls back to the in-memory store, which is exactly what
 * this project used before: degraded, not broken.
 */
class ResilientStore implements Store {
	/** Redis counters are shared between instances. The fallback's are not. */
	readonly localKeys = false;

	private readonly local = new MemoryStore();
	private shared: RedisStore | null = null;
	private options: Options | null = null;
	private warned = false;

	constructor(readonly prefix: string) {}

	init(options: Options): void {
		this.options = options;
		this.local.init(options);
	}

	/**
	 * Built on demand, never at module load. `RedisStore.init()` caches the
	 * promise of its `SCRIPT LOAD`, so a store first initialised while the
	 * socket was still down would hold a rejected promise for the life of the
	 * process. Rebuilding on recovery is what keeps the fallback temporary.
	 */
	private async connect(): Promise<RedisStore> {
		if (this.shared) return this.shared;
		if (!this.options) throw new Error("rate limiter store used before init");

		const store = new RedisStore({ prefix: this.prefix, sendCommand });
		await store.init(this.options);
		this.shared = store;
		if (this.warned) logger.info({ limiter: this.prefix }, "rate limiter is back on Redis");
		this.warned = false;
		return store;
	}

	/** One warning per outage; a reconnect loop must not flood the log. */
	private degrade(err: unknown): void {
		this.shared = null;
		if (this.warned) return;
		this.warned = true;
		logger.warn(
			{ err: (err as Error).message, limiter: this.prefix },
			"rate limiter fell back to per-instance counters",
		);
	}

	async increment(key: string): Promise<IncrementResponse> {
		try {
			return await (await this.connect()).increment(key);
		} catch (err) {
			this.degrade(err);
			return this.local.increment(key);
		}
	}

	/**
	 * `skipSuccessfulRequests` hands a hit back once the response is written.
	 * It goes to whichever store is healthy now, which is the one that took the
	 * increment: a failed increment clears `shared` before falling back.
	 */
	async decrement(key: string): Promise<void> {
		try {
			if (this.shared) {
				await this.shared.decrement(key);
				return;
			}
		} catch (err) {
			this.degrade(err);
		}
		await this.local.decrement(key);
	}

	async resetKey(key: string): Promise<void> {
		try {
			await this.shared?.resetKey(key);
		} catch (err) {
			this.degrade(err);
		}
		await this.local.resetKey(key);
	}

	async get(key: string): Promise<IncrementResponse | undefined> {
		try {
			if (this.shared) return await this.shared.get(key);
		} catch (err) {
			this.degrade(err);
		}
		return this.local.get(key);
	}
}

const base = (
	name: string,
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
		// Its own key space per limiter, so the global budget and the auth budget
		// never spend each other's allowance.
		...(useRedis && { store: new ResilientStore(`rl:${name}:`) }),
		...extra,
	});

/** 100 requests / 15 min per IP across the whole API (RATE_LIMIT_GLOBAL_MAX). */
export const globalLimiter = base(
	"global",
	15 * 60_000,
	env.RATE_LIMIT_GLOBAL_MAX,
	"RATE_LIMITED",
	"Too many requests, please slow down",
);

/**
 * Register, login, resend-otp, forgot-password: 5 / 15 min per IP
 * (RATE_LIMIT_AUTH_MAX).
 *
 * Only *failed* attempts count. What this limiter defends against is guessing,
 * and a successful login is not a guess — counting it would lock out the one
 * person who typed the right password, while a bot that fails every time gets
 * the same five tries either way.
 */
export const authLimiter = base(
	"auth",
	15 * 60_000,
	env.RATE_LIMIT_AUTH_MAX,
	"RATE_LIMITED",
	"Too many attempts, try again in 15 minutes",
	{ skipSuccessfulRequests: true },
);

/** Payment initiate: 10 / hour per IP. */
export const paymentLimiter = base(
	"payment",
	60 * 60_000,
	10,
	"RATE_LIMITED",
	"Too many payment attempts, try again later",
);

/** Gateway callbacks are public, so they get their own tighter budget. */
export const callbackLimiter = base(
	"callback",
	60_000,
	20,
	"RATE_LIMITED",
	"Too many callback requests",
);

/** Admin routes: 30 / min. */
export const adminLimiter = base("admin", 60_000, 30, "RATE_LIMITED", "Too many admin requests");
