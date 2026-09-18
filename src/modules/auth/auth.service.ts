import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { env } from "@/config/env.js";
import type { GoogleProfile } from "@/config/passport.js";
import { redis } from "@/config/redis.js";
import type { SecurityEventType } from "@/generated/prisma/enums.js";
import { invalidate } from "@/lib/cache.js";
import { logger } from "@/lib/logger.js";
import {
	sendLoginOtpEmail,
	sendNewLoginAlert,
	sendOtpEmail,
	sendPasswordResetEmail,
} from "@/lib/mailer.js";
import { otpCounter } from "@/lib/metrics.js";
import { prisma } from "@/lib/prisma.js";
import { getSetting } from "@/lib/settings.js";
import {
	DUMMY_HASH,
	GENERIC_INVALID_CREDENTIALS,
	KEYS,
	LIMITS,
	REVOKE_REASON,
	TTL,
} from "@/modules/auth/auth.constants.js";
import { ApiError } from "@/utils/ApiError.js";
import { AUDIT_ACTIONS, audit } from "@/utils/auditLogger.js";
import type { Ctx } from "@/utils/context.js";
import { toAuditCtx } from "@/utils/context.js";
import { maskEmail, otpHash, randomOtp, randomToken, safeEqual, sha256 } from "@/utils/crypto.js";
import { remainingTtl, signAccessToken, signRefreshToken } from "@/utils/jwt.js";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

type PendingSignup = {
	name: string;
	email: string;
	provider: "LOCAL" | "GOOGLE";
	passwordHash: string | null;
	googleId: string | null;
	avatarUrl: string | null;
	phone: string | null;
	otpHash: string;
	attempts: number;
};

type LoginChallenge = {
	userId: string;
	otpHash: string;
	attempts: number;
	resends: number;
	ipHash: string;
	uaHash: string;
	/** So whoever ends the challenge can take the emailed link down with it. */
	magicHash?: string;
};

export type PublicUser = {
	id: string;
	name: string;
	email: string;
	role: string;
	avatarUrl: string | null;
};

const publicUser = (u: {
	id: string;
	name: string;
	email: string;
	role: string;
	avatarUrl?: string | null;
}): PublicUser => ({
	id: u.id,
	name: u.name,
	email: u.email,
	role: u.role,
	avatarUrl: u.avatarUrl ?? null,
});

/**
 * OTP flows genuinely need Redis; a clear 503 beats an opaque 500.
 *
 * An `ApiError` raised inside the callback is a deliberate answer — the 60
 * second resend cooldown, the hourly send cap — so it passes straight through.
 * Only an unexpected failure means Redis itself is the problem.
 */
const requireRedis = async <T>(fn: () => Promise<T>): Promise<T> => {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ApiError) throw err;
		logger.error({ err }, "redis operation failed");
		throw new ApiError(503, "Verification service is temporarily unavailable", [
			{ code: "SERVICE_UNAVAILABLE", message: "Please try again in a moment" },
		]);
	}
};

export const logSecurity = async (input: {
	userId?: string | null;
	email?: string | null;
	type: SecurityEventType;
	ctx: Ctx;
	meta?: Record<string, unknown>;
}): Promise<void> => {
	await prisma.securityEvent.create({
		data: {
			userId: input.userId ?? null,
			email: input.email ?? null,
			type: input.type,
			ip: input.ctx.ip,
			userAgent: input.ctx.ua,
			meta: (input.meta ?? undefined) as never,
		},
	});

	// One IP hammering logins is worth an alert, not just a row in a table.
	if (input.type === "LOGIN_FAILED") {
		const key = KEYS.loginFailIpAlert(input.ctx.ip);
		const count = await redis.incr(key).catch(() => 0);
		if (count === 1) await redis.expire(key, 3600).catch(() => {});
		if (count === LIMITS.ipAlertThreshold) {
			logger.warn({ ip: input.ctx.ip, count }, "brute force suspected from single IP");
		}
	}
};

/** Password change, role change and blocking all end here. */
export const revokeAllSessions = async (userId: string, reason: string): Promise<number> => {
	const sessions = await prisma.session.findMany({
		where: { userId, revokedAt: null },
		select: { id: true },
	});

	await prisma.$transaction([
		prisma.session.updateMany({
			where: { userId, revokedAt: null },
			data: { revokedAt: new Date(), revokedReason: reason },
		}),
		prisma.refreshToken.updateMany({
			where: { userId, revokedAt: null },
			data: { revokedAt: new Date() },
		}),
	]);

	await invalidate(...sessions.map((s) => KEYS.session(s.id)));
	return sessions.length;
};

export const isTrustedDevice = async (userId: string, deviceToken: string): Promise<boolean> => {
	const row = await prisma.trustedDevice.findUnique({
		where: { tokenHash: sha256(deviceToken) },
	});
	return Boolean(row && row.userId === userId && row.expiresAt > new Date());
};

export const createTrustedDevice = async (userId: string, ua: string): Promise<string> => {
	const token = randomToken(32);
	await prisma.trustedDevice.create({
		data: {
			userId,
			tokenHash: sha256(token),
			userAgent: ua,
			expiresAt: new Date(Date.now() + TTL.trustedDeviceDays * 86_400_000),
		},
	});
	return token;
};

/**
 * Mints the one-click half of a two-factor challenge and writes the pointer
 * into `challenge.magicHash`, so ending the challenge any other way can take
 * this link down too. Mutates `challenge`; the caller persists it.
 */
const issueMagicLink = async (
	challenge: LoginChallenge,
	challengeId: string,
	ttl: number,
): Promise<string> => {
	if (challenge.magicHash) await redis.del(KEYS.loginMagic(challenge.magicHash)).catch(() => {});

	const token = randomToken(32);
	challenge.magicHash = sha256(token);
	await requireRedis(() =>
		redis.set(KEYS.loginMagic(challenge.magicHash as string), challengeId, "EX", ttl),
	);

	return `${env.BACKEND_URL}/api/v1/auth/login/magic?token=${token}`;
};

/** Ends a challenge: the code and the emailed link both stop working. */
const endChallenge = async (challengeId: string, challenge: LoginChallenge): Promise<number> => {
	if (challenge.magicHash) await redis.del(KEYS.loginMagic(challenge.magicHash)).catch(() => {});
	return redis.del(KEYS.loginOtp(challengeId));
};

/** "New" = this user has never signed in from this user agent before. */
export const isNewDevice = async (userId: string, ctx: Ctx): Promise<boolean> => {
	const seen = await prisma.session.count({ where: { userId, userAgent: ctx.ua } });
	return seen === 0;
};

export const createSessionAndTokens = async (
	user: {
		id: string;
		name: string;
		email: string;
		role: string;
		avatarUrl?: string | null;
		isSuperAdmin?: boolean;
	},
	ctx: Ctx,
) => {
	// A super admin session is deliberately short-lived.
	const lifetimeMs = user.isSuperAdmin
		? TTL.superAdminSessionHours * 3600_000
		: TTL.refreshDays * 86_400_000;

	const session = await prisma.session.create({
		data: {
			userId: user.id,
			ip: ctx.ip,
			userAgent: ctx.ua,
			deviceName: ctx.ua.slice(0, 80),
			expiresAt: new Date(Date.now() + lifetimeMs),
		},
	});

	const { token: accessToken } = signAccessToken({
		sub: user.id,
		role: user.role as never,
		sid: session.id,
	});
	const { token: refreshToken } = signRefreshToken({ sub: user.id, sid: session.id });

	await prisma.refreshToken.create({
		data: {
			tokenHash: sha256(refreshToken),
			userId: user.id,
			sessionId: session.id,
			expiresAt: new Date(Date.now() + lifetimeMs),
		},
	});

	await prisma.user.update({
		where: { id: user.id },
		data: { lastLoginAt: new Date(), lastLoginIp: ctx.ip },
	});

	await logSecurity({ userId: user.id, type: "LOGIN_SUCCESS", ctx });

	return { accessToken, refreshToken, user: publicUser(user) };
};

// ---------------------------------------------------------------------------
// signup — Redis first, Postgres only after the email is proven
// ---------------------------------------------------------------------------

export const startSignup = async (input: {
	name: string;
	email: string;
	password?: string;
	phone?: string;
	provider?: "LOCAL" | "GOOGLE";
	googleId?: string;
	avatarUrl?: string;
}) => {
	const email = input.email.trim().toLowerCase();

	const exists = await prisma.user.findFirst({ where: { email }, select: { id: true } });
	if (exists) {
		throw new ApiError(409, "Email already registered", [
			{ code: "EMAIL_EXISTS", message: "Email already registered" },
		]);
	}

	return requireRedis(async () => {
		if (await redis.exists(KEYS.otpCooldown(email))) {
			throw new ApiError(429, "Please wait 60 seconds before requesting another OTP", [
				{ code: "OTP_COOLDOWN", message: "Please wait 60 seconds" },
			]);
		}

		const sends = await redis.incr(KEYS.otpSends(email));
		if (sends === 1) await redis.expire(KEYS.otpSends(email), TTL.otpSends);
		if (sends > LIMITS.otpSendsPerHour) {
			throw new ApiError(429, "Too many OTP requests, try again in an hour", [
				{ code: "RATE_LIMITED", message: "Too many OTP requests" },
			]);
		}

		const ttl = await getSetting("SIGNUP_OTP_TTL_SEC");
		const otp = randomOtp();
		const pending: PendingSignup = {
			name: input.name,
			email,
			provider: input.provider ?? "LOCAL",
			passwordHash: input.password
				? await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS)
				: null,
			googleId: input.googleId ?? null,
			avatarUrl: input.avatarUrl ?? null,
			phone: input.phone ?? null,
			otpHash: otpHash(otp),
			attempts: 0,
		};

		await redis.set(KEYS.pendingSignup(email), JSON.stringify(pending), "EX", ttl);
		await redis.set(KEYS.otpCooldown(email), "1", "EX", TTL.otpCooldown);
		await sendOtpEmail(email, otp, Math.round(ttl / 60));
		otpCounter.inc({ kind: "signup", outcome: "sent" });

		return { email: maskEmail(email), expiresInSec: ttl };
	});
};

export const verifyOtp = async (emailRaw: string, otp: string, ctx: Ctx) => {
	const email = emailRaw.trim().toLowerCase();
	const key = KEYS.pendingSignup(email);

	const raw = await requireRedis(() => redis.get(key));
	if (!raw) {
		throw new ApiError(400, "OTP expired or signup not started", [
			{ code: "OTP_EXPIRED", message: "OTP expired or signup not started" },
		]);
	}

	const pending = JSON.parse(raw) as PendingSignup;

	if (pending.attempts >= LIMITS.signupOtpAttempts) {
		await redis.del(key);
		throw new ApiError(429, "Too many wrong attempts, please register again", [
			{ code: "RATE_LIMITED", message: "Too many wrong attempts" },
		]);
	}

	if (!safeEqual(otpHash(otp), pending.otpHash)) {
		pending.attempts += 1;
		await redis.set(key, JSON.stringify(pending), "KEEPTTL");
		otpCounter.inc({ kind: "signup", outcome: "failed" });
		const left = LIMITS.signupOtpAttempts - pending.attempts;
		throw new ApiError(400, `Invalid OTP, ${left} attempts left`, [
			{ code: "OTP_INVALID", message: `Invalid OTP, ${left} attempts left` },
		]);
	}

	const user = await prisma.$transaction(async (tx) => {
		const created = await tx.user.create({
			data: {
				name: pending.name,
				email,
				password: pending.passwordHash,
				phone: pending.phone,
				provider: pending.provider,
				googleId: pending.googleId,
				avatarUrl: pending.avatarUrl,
				role: "CITIZEN",
				emailVerifiedAt: new Date(),
			},
			select: { id: true, name: true, email: true, role: true, avatarUrl: true },
		});

		await audit(tx, {
			actorId: created.id,
			action: AUDIT_ACTIONS.USER_REGISTERED,
			entityType: "User",
			entityId: created.id,
			ctx: toAuditCtx(ctx),
		});

		return created;
	});

	await redis.del(key, KEYS.otpCooldown(email), KEYS.otpSends(email)).catch(() => {});
	return createSessionAndTokens(user, ctx);
};

export const resendOtp = async (emailRaw: string) => {
	const email = emailRaw.trim().toLowerCase();
	const key = KEYS.pendingSignup(email);
	const ttl = await getSetting("SIGNUP_OTP_TTL_SEC");
	// An unknown email gets exactly the same answer — no enumeration.
	const generic = { email: maskEmail(email), expiresInSec: ttl };

	return requireRedis(async () => {
		const raw = await redis.get(key);
		if (!raw) return generic;

		if (await redis.exists(KEYS.otpCooldown(email))) {
			throw new ApiError(429, "Please wait 60 seconds before requesting another OTP", [
				{ code: "OTP_COOLDOWN", message: "Please wait 60 seconds" },
			]);
		}

		const sends = await redis.incr(KEYS.otpSends(email));
		if (sends === 1) await redis.expire(KEYS.otpSends(email), TTL.otpSends);
		if (sends > LIMITS.otpSendsPerHour) {
			throw new ApiError(429, "Too many OTP requests, try again in an hour", [
				{ code: "RATE_LIMITED", message: "Too many OTP requests" },
			]);
		}

		const pending = JSON.parse(raw) as PendingSignup;
		const otp = randomOtp();
		pending.otpHash = otpHash(otp);
		pending.attempts = 0;

		await redis.set(key, JSON.stringify(pending), "EX", ttl);
		await redis.set(KEYS.otpCooldown(email), "1", "EX", TTL.otpCooldown);
		await sendOtpEmail(email, otp, Math.round(ttl / 60));
		otpCounter.inc({ kind: "signup", outcome: "sent" });

		return generic;
	});
};

// ---------------------------------------------------------------------------
// login — password, then a second factor unless the device is trusted
// ---------------------------------------------------------------------------

export const login = async (
	emailRaw: string,
	password: string,
	ctx: Ctx & { deviceToken?: string },
) => {
	const email = emailRaw.trim().toLowerCase();

	const ipFails = Number(await redis.get(KEYS.loginIp(ctx.ip)).catch(() => 0));
	if (ipFails >= LIMITS.loginFailPerIp) {
		throw new ApiError(429, "Too many failed logins from this network", [
			{ code: "RATE_LIMITED", message: "Too many failed logins" },
		]);
	}

	const fails = Number(await redis.get(KEYS.loginFail(email)).catch(() => 0));
	if (fails >= LIMITS.loginFailBeforeLongLock) {
		throw new ApiError(423, "Account temporarily locked, try again in an hour", [
			{ code: "ACCOUNT_LOCKED", message: "Account temporarily locked" },
		]);
	}
	if (fails >= LIMITS.loginFailBeforeLock) {
		throw new ApiError(423, "Account temporarily locked, try again in 15 minutes", [
			{ code: "ACCOUNT_LOCKED", message: "Account temporarily locked" },
		]);
	}

	const user = await prisma.user.findFirst({ where: { email } });
	// Always run a compare, even for an unknown email: same answer, same timing.
	const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);

	if (!user || !ok) {
		const n = await redis.incr(KEYS.loginFail(email)).catch(() => 0);
		if (n === 1) await redis.expire(KEYS.loginFail(email), TTL.loginFail).catch(() => {});
		if (n === LIMITS.loginFailBeforeLock) {
			await redis.expire(KEYS.loginFail(email), TTL.loginFailLong).catch(() => {});
		}
		const ipCount = await redis.incr(KEYS.loginIp(ctx.ip)).catch(() => 0);
		if (ipCount === 1) await redis.expire(KEYS.loginIp(ctx.ip), TTL.loginIp).catch(() => {});

		await logSecurity({
			email,
			userId: user?.id,
			type: n >= LIMITS.loginFailBeforeLock ? "ACCOUNT_LOCKED" : "LOGIN_FAILED",
			ctx,
		});

		throw new ApiError(401, GENERIC_INVALID_CREDENTIALS, [
			{ code: "INVALID_CREDENTIALS", message: GENERIC_INVALID_CREDENTIALS },
		]);
	}

	if (user.status === "BLOCKED") {
		throw new ApiError(403, "Account is blocked", [
			{ code: "ACCOUNT_BLOCKED", message: "Account is blocked" },
		]);
	}

	await redis.del(KEYS.loginFail(email)).catch(() => {});

	// `twoFactorEnabled` is the single switch. Officers and admins are created with
	// it ON (see admin.service), and PATCH /auth/2fa refuses to turn it off for any
	// role but CITIZEN — so only the seed can hand out an OTP-free staff account,
	// which is what makes the demo credentials usable without a mailbox.
	const mustOtp = user.twoFactorEnabled;
	const trusted =
		user.role === "CITIZEN" &&
		Boolean(ctx.deviceToken) &&
		(await isTrustedDevice(user.id, ctx.deviceToken as string));

	if (!mustOtp || trusted) {
		return { twoFactorRequired: false as const, ...(await createSessionAndTokens(user, ctx)) };
	}

	const ttl = await getSetting("LOGIN_OTP_TTL_SEC");
	const challengeId = randomToken(32);
	const otp = randomOtp();
	const challenge: LoginChallenge = {
		userId: user.id,
		otpHash: otpHash(otp),
		attempts: 0,
		resends: 0,
		ipHash: sha256(ctx.ip),
		uaHash: sha256(ctx.ua),
	};

	// The same challenge, reachable two ways: type the code, or open the link.
	// The link is a second pointer at `challengeId`, never a second credential —
	// whichever one is used first ends the challenge and kills the other.
	const magicLink = await issueMagicLink(challenge, challengeId, ttl);
	await requireRedis(() =>
		redis.set(KEYS.loginOtp(challengeId), JSON.stringify(challenge), "EX", ttl),
	);

	await sendLoginOtpEmail(user.email, otp, Math.round(ttl / 60), magicLink);
	await logSecurity({ userId: user.id, type: "OTP_SENT", ctx });
	otpCounter.inc({ kind: "login", outcome: "sent" });

	return {
		twoFactorRequired: true as const,
		challengeId,
		email: maskEmail(user.email),
		expiresInSec: ttl,
	};
};

export const verifyLoginOtp = async (
	challengeId: string,
	otp: string,
	trustDevice: boolean,
	ctx: Ctx,
) => {
	const key = KEYS.loginOtp(challengeId);
	const raw = await requireRedis(() => redis.get(key));

	if (!raw) {
		throw new ApiError(400, "Challenge expired, please login again", [
			{ code: "OTP_EXPIRED", message: "Challenge expired" },
		]);
	}

	const challenge = JSON.parse(raw) as LoginChallenge;

	// A challenge belongs to the browser that started it.
	if (challenge.uaHash !== sha256(ctx.ua)) {
		await redis.del(key);
		throw new ApiError(401, "Device mismatch, please login again", [
			{ code: "INVALID_CREDENTIALS", message: "Device mismatch" },
		]);
	}

	if (!safeEqual(otpHash(otp), challenge.otpHash)) {
		challenge.attempts += 1;
		if (challenge.attempts >= LIMITS.loginOtpAttempts) await endChallenge(challengeId, challenge);
		else await redis.set(key, JSON.stringify(challenge), "KEEPTTL");
		await logSecurity({ userId: challenge.userId, type: "OTP_FAILED", ctx });
		otpCounter.inc({ kind: "login", outcome: "failed" });
		throw new ApiError(400, "Invalid OTP", [{ code: "OTP_INVALID", message: "Invalid OTP" }]);
	}

	// Single use, race safe: whoever deletes the key first wins. The emailed
	// link goes at the same time, so only one of the two ways in can be used.
	if ((await endChallenge(challengeId, challenge)) === 0) {
		throw new ApiError(400, "OTP already used", [
			{ code: "OTP_EXPIRED", message: "OTP already used" },
		]);
	}

	const user = await prisma.user.findFirst({ where: { id: challenge.userId } });
	if (!user) throw new ApiError(401, "User no longer exists");

	const newDevice = await isNewDevice(user.id, ctx);
	const tokens = await createSessionAndTokens(user, ctx);

	const deviceToken =
		trustDevice && user.role === "CITIZEN" ? await createTrustedDevice(user.id, ctx.ua) : undefined;

	if (newDevice) {
		await logSecurity({ userId: user.id, type: "NEW_DEVICE", ctx });
		await sendNewLoginAlert(user.email, { ip: ctx.ip, userAgent: ctx.ua });
	}

	return { ...tokens, deviceToken };
};

/**
 * The other way through the same challenge: the link from the email.
 *
 * Three things make this safe enough to put a credential in a URL. The token is
 * 32 random bytes and only its SHA-256 is stored, so a Redis dump is useless.
 * It dies with the challenge — five minutes — and the `DEL` below is the single
 * use: whoever removes the key first wins, and the challenge goes with it, so
 * the emailed code cannot be used afterwards either.
 *
 * What it deliberately does *not* do is check the user agent. `verifyLoginOtp`
 * refuses a challenge from a different browser, but a link is opened in the
 * mail client, never in the app that started the login — binding it would mean
 * the feature never works. That is the trade: this path is the short-lived,
 * single-use, alerted one, and it never mints a trusted device, because a click
 * cannot tell us the person meant to trust the machine they clicked on.
 */
export const completeMagicLogin = async (token: string, ctx: Ctx) => {
	const magicKey = KEYS.loginMagic(sha256(token));
	const invalid = new ApiError(400, "This sign-in link is invalid, used or expired", [
		{ code: "OTP_EXPIRED", message: "Request a new login code" },
	]);

	const challengeId = await requireRedis(() => redis.get(magicKey));
	if (!challengeId) throw invalid;

	const challengeKey = KEYS.loginOtp(challengeId);
	const raw = await requireRedis(() => redis.get(challengeKey));
	if (!raw) throw invalid;

	// Single use, race safe: two clicks on the same link, only one gets in.
	if ((await redis.del(magicKey)) === 0) throw invalid;

	const challenge = JSON.parse(raw) as LoginChallenge;
	await endChallenge(challengeId, challenge);

	const user = await prisma.user.findFirst({ where: { id: challenge.userId } });
	if (!user) throw new ApiError(401, "User no longer exists");

	const newDevice = await isNewDevice(user.id, ctx);
	const tokens = await createSessionAndTokens(user, ctx);
	otpCounter.inc({ kind: "login", outcome: "magic" });

	if (newDevice) {
		await logSecurity({ userId: user.id, type: "NEW_DEVICE", ctx });
		await sendNewLoginAlert(user.email, { ip: ctx.ip, userAgent: ctx.ua });
	}

	return tokens;
};

export const resendLoginOtp = async (challengeId: string, ctx: Ctx) => {
	const key = KEYS.loginOtp(challengeId);
	const raw = await requireRedis(() => redis.get(key));
	if (!raw) {
		throw new ApiError(400, "Challenge expired, please login again", [
			{ code: "OTP_EXPIRED", message: "Challenge expired" },
		]);
	}

	const challenge = JSON.parse(raw) as LoginChallenge;
	if (challenge.resends >= LIMITS.loginOtpResends) {
		throw new ApiError(429, "Too many resend requests, please login again", [
			{ code: "RATE_LIMITED", message: "Too many resend requests" },
		]);
	}

	const cooldownKey = `${key}:cooldown`;
	if (await redis.exists(cooldownKey)) {
		throw new ApiError(429, "Please wait 60 seconds before requesting another OTP", [
			{ code: "OTP_COOLDOWN", message: "Please wait 60 seconds" },
		]);
	}

	const user = await prisma.user.findFirst({
		where: { id: challenge.userId },
		select: { email: true },
	});
	if (!user) throw new ApiError(401, "User no longer exists");

	const ttl = await getSetting("LOGIN_OTP_TTL_SEC");
	const otp = randomOtp();
	challenge.otpHash = otpHash(otp);
	challenge.attempts = 0;
	challenge.resends += 1;

	// A resend supersedes the earlier email, link included.
	const magicLink = await issueMagicLink(challenge, challengeId, ttl);

	await redis.set(key, JSON.stringify(challenge), "EX", ttl);
	await redis.set(cooldownKey, "1", "EX", TTL.otpCooldown);
	await sendLoginOtpEmail(user.email, otp, Math.round(ttl / 60), magicLink);
	await logSecurity({ userId: challenge.userId, type: "OTP_SENT", ctx });

	return { challengeId, expiresInSec: ttl };
};

// ---------------------------------------------------------------------------
// tokens and sessions
// ---------------------------------------------------------------------------

export const refresh = async (token: string, ctx: Ctx) => {
	const tokenHash = sha256(token);
	const row = await prisma.refreshToken.findUnique({
		where: { tokenHash },
		include: { session: true },
	});

	if (!row) {
		throw new ApiError(401, "Invalid refresh token", [
			{ code: "TOKEN_INVALID", message: "Invalid refresh token" },
		]);
	}

	// A revoked token presented again means it was stolen and replayed.
	if (row.revokedAt) {
		await revokeAllSessions(row.userId, REVOKE_REASON.TOKEN_REUSE);
		await logSecurity({ userId: row.userId, type: "TOKEN_REUSE", ctx });
		throw new ApiError(401, "Refresh token reuse detected, all sessions revoked", [
			{ code: "TOKEN_REVOKED", message: "Refresh token reuse detected" },
		]);
	}

	if (row.expiresAt < new Date() || row.session.revokedAt || row.session.expiresAt < new Date()) {
		throw new ApiError(401, "Refresh token expired", [
			{ code: "TOKEN_EXPIRED", message: "Refresh token expired" },
		]);
	}

	const user = await prisma.user.findFirst({ where: { id: row.userId } });
	if (!user) throw new ApiError(401, "User no longer exists");
	if (user.status === "BLOCKED") {
		throw new ApiError(403, "Account is blocked", [{ code: "ACCOUNT_BLOCKED" }]);
	}

	const { token: accessToken } = signAccessToken({
		sub: user.id,
		role: user.role,
		sid: row.sessionId,
	});
	const { token: refreshToken } = signRefreshToken({ sub: user.id, sid: row.sessionId });

	await prisma.$transaction(async (tx) => {
		const next = await tx.refreshToken.create({
			data: {
				tokenHash: sha256(refreshToken),
				userId: user.id,
				sessionId: row.sessionId,
				expiresAt: row.session.expiresAt,
			},
		});
		await tx.refreshToken.update({
			where: { id: row.id },
			data: { revokedAt: new Date(), replacedById: next.id },
		});
		await tx.session.update({
			where: { id: row.sessionId },
			data: { lastUsedAt: new Date() },
		});
	});

	return { accessToken, refreshToken, user: publicUser(user) };
};

export const logout = async (
	userId: string,
	sessionId: string,
	accessToken: { jti: string; exp: number },
): Promise<void> => {
	await prisma.$transaction([
		prisma.session.updateMany({
			where: { id: sessionId, userId, revokedAt: null },
			data: { revokedAt: new Date(), revokedReason: REVOKE_REASON.LOGOUT },
		}),
		prisma.refreshToken.updateMany({
			where: { sessionId, revokedAt: null },
			data: { revokedAt: new Date() },
		}),
	]);

	// The access token is still cryptographically valid for up to 15 minutes,
	// so it goes on the denylist for exactly that long.
	await redis
		.set(KEYS.jwtDeny(accessToken.jti), "1", "EX", remainingTtl(accessToken.exp))
		.catch(() => {});
	await invalidate(KEYS.session(sessionId));
};

export const logoutAll = async (userId: string): Promise<{ revoked: number }> => {
	const revoked = await revokeAllSessions(userId, REVOKE_REASON.LOGOUT);
	return { revoked };
};

export const listSessions = async (userId: string, currentSessionId?: string) => {
	const sessions = await prisma.session.findMany({
		where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
		orderBy: { lastUsedAt: "desc" },
		select: {
			id: true,
			ip: true,
			userAgent: true,
			deviceName: true,
			lastUsedAt: true,
			createdAt: true,
			expiresAt: true,
		},
	});

	return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
};

export const revokeSession = async (userId: string, sessionId: string): Promise<void> => {
	const session = await prisma.session.findFirst({ where: { id: sessionId, userId } });
	if (!session) {
		throw new ApiError(404, "Session not found", [
			{ code: "NOT_FOUND", message: "Session not found" },
		]);
	}

	await prisma.$transaction([
		prisma.session.update({
			where: { id: sessionId },
			data: { revokedAt: new Date(), revokedReason: REVOKE_REASON.LOGOUT },
		}),
		prisma.refreshToken.updateMany({
			where: { sessionId, revokedAt: null },
			data: { revokedAt: new Date() },
		}),
	]);

	await invalidate(KEYS.session(sessionId));
};

// ---------------------------------------------------------------------------
// two-factor, passwords
// ---------------------------------------------------------------------------

export const toggle2fa = async (
	userId: string,
	input: { enabled: boolean; password: string; challengeId?: string; otp?: string },
	ctx: Ctx,
) => {
	const user = await prisma.user.findFirst({ where: { id: userId } });
	if (!user) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	if (user.role !== "CITIZEN") {
		throw new ApiError(403, "Officers and admins must keep two-factor authentication on", [
			{ code: "FORBIDDEN_ROLE", message: "Two-factor is mandatory for this role" },
		]);
	}

	const ok = await bcrypt.compare(input.password, user.password ?? DUMMY_HASH);
	if (!ok) {
		throw new ApiError(401, GENERIC_INVALID_CREDENTIALS, [{ code: "INVALID_CREDENTIALS" }]);
	}

	// Step 1: no OTP yet -> issue a fresh challenge.
	if (!input.challengeId || !input.otp) {
		const ttl = await getSetting("LOGIN_OTP_TTL_SEC");
		const challengeId = randomToken(32);
		const otp = randomOtp();
		const challenge: LoginChallenge = {
			userId: user.id,
			otpHash: otpHash(otp),
			attempts: 0,
			resends: 0,
			ipHash: sha256(ctx.ip),
			uaHash: sha256(ctx.ua),
		};
		await requireRedis(() =>
			redis.set(KEYS.loginOtp(challengeId), JSON.stringify(challenge), "EX", ttl),
		);
		await sendLoginOtpEmail(user.email, otp, Math.round(ttl / 60));
		return { otpRequired: true as const, challengeId, expiresInSec: ttl };
	}

	// Step 2: verify and apply.
	const key = KEYS.loginOtp(input.challengeId);
	const raw = await requireRedis(() => redis.get(key));
	if (!raw) {
		throw new ApiError(400, "Challenge expired, please try again", [{ code: "OTP_EXPIRED" }]);
	}

	const challenge = JSON.parse(raw) as LoginChallenge;
	if (challenge.userId !== user.id || !safeEqual(otpHash(input.otp), challenge.otpHash)) {
		await logSecurity({ userId: user.id, type: "OTP_FAILED", ctx });
		throw new ApiError(400, "Invalid OTP", [{ code: "OTP_INVALID", message: "Invalid OTP" }]);
	}
	await redis.del(key);

	await prisma.$transaction(async (tx) => {
		await tx.user.update({ where: { id: user.id }, data: { twoFactorEnabled: input.enabled } });
		await audit(tx, {
			actorId: user.id,
			action: AUDIT_ACTIONS.TWO_FA_TOGGLED,
			entityType: "User",
			entityId: user.id,
			before: { twoFactorEnabled: user.twoFactorEnabled },
			after: { twoFactorEnabled: input.enabled },
			ctx: toAuditCtx(ctx),
		});
	});

	await logSecurity({ userId: user.id, type: "TWO_FA_TOGGLED", ctx });
	return { otpRequired: false as const, twoFactorEnabled: input.enabled };
};

export const forgotPassword = async (emailRaw: string) => {
	const email = emailRaw.trim().toLowerCase();
	// Identical answer whether or not the account exists.
	const generic = { message: "If that email exists, a reset link has been sent" };

	const user = await prisma.user.findFirst({ where: { email }, select: { id: true, email: true } });
	if (!user) return generic;

	const token = randomToken(32);
	await redis
		.set(KEYS.passwordReset(sha256(token)), user.id, "EX", TTL.passwordReset)
		.catch(() => {});
	await sendPasswordResetEmail(user.email, token);

	return generic;
};

export const resetPassword = async (token: string, password: string, ctx: Ctx) => {
	const key = KEYS.passwordReset(sha256(token));
	const userId = await requireRedis(() => redis.get(key));

	if (!userId) {
		throw new ApiError(400, "Reset link is invalid or has expired", [
			{ code: "OTP_EXPIRED", message: "Reset link is invalid or has expired" },
		]);
	}

	const user = await prisma.user.findFirst({ where: { id: userId } });
	if (!user) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id: user.id },
			data: {
				password: await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS),
				passwordChangedAt: new Date(),
			},
		});
		await audit(tx, {
			actorId: user.id,
			action: AUDIT_ACTIONS.PASSWORD_CHANGED,
			entityType: "User",
			entityId: user.id,
			ctx: toAuditCtx(ctx),
		});
	});

	await redis.del(key).catch(() => {});
	await revokeAllSessions(user.id, REVOKE_REASON.PASSWORD_CHANGED);
	await logSecurity({ userId: user.id, type: "PASSWORD_CHANGED", ctx });

	return { message: "Password updated, please login again" };
};

export const changePassword = async (
	userId: string,
	input: { currentPassword: string; newPassword: string },
	ctx: Ctx,
) => {
	const user = await prisma.user.findFirst({ where: { id: userId } });
	if (!user) throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);

	const ok = await bcrypt.compare(input.currentPassword, user.password ?? DUMMY_HASH);
	if (!ok) {
		throw new ApiError(401, "Current password is incorrect", [{ code: "INVALID_CREDENTIALS" }]);
	}

	await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id: user.id },
			data: {
				password: await bcrypt.hash(input.newPassword, env.BCRYPT_SALT_ROUNDS),
				passwordChangedAt: new Date(),
			},
		});
		await audit(tx, {
			actorId: user.id,
			action: AUDIT_ACTIONS.PASSWORD_CHANGED,
			entityType: "User",
			entityId: user.id,
			ctx: toAuditCtx(ctx),
		});
	});

	await revokeAllSessions(user.id, REVOKE_REASON.PASSWORD_CHANGED);
	await logSecurity({ userId: user.id, type: "PASSWORD_CHANGED", ctx });

	return { message: "Password changed, please login again" };
};

// ---------------------------------------------------------------------------
// google
// ---------------------------------------------------------------------------

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * Shared by the browser callback and the Postman-friendly id-token endpoint.
 * A brand new Google user still walks through the OTP flow, so one code path
 * creates every account.
 */
export const handleGoogleProfile = async (profile: GoogleProfile, ctx: Ctx) => {
	if (!profile.emailVerified) {
		throw new ApiError(403, "Google account email is not verified", [
			{ code: "FORBIDDEN_ROLE", message: "Email not verified with Google" },
		]);
	}

	const existing = await prisma.user.findFirst({
		where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
	});

	if (!existing) {
		const pending = await startSignup({
			name: profile.name,
			email: profile.email,
			provider: "GOOGLE",
			googleId: profile.googleId,
			avatarUrl: profile.avatarUrl,
		});
		return { newUser: true as const, ...pending };
	}

	if (existing.status === "BLOCKED") {
		throw new ApiError(403, "Account is blocked", [{ code: "ACCOUNT_BLOCKED" }]);
	}

	// Same email, first time through Google: link the accounts.
	if (!existing.googleId) {
		await prisma.user.update({
			where: { id: existing.id },
			data: { googleId: profile.googleId, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
		});
	}

	const mustOtp = existing.twoFactorEnabled;
	if (!mustOtp) {
		return {
			newUser: false as const,
			twoFactorRequired: false as const,
			...(await createSessionAndTokens(existing, ctx)),
		};
	}

	const ttl = await getSetting("LOGIN_OTP_TTL_SEC");
	const challengeId = randomToken(32);
	const otp = randomOtp();
	await requireRedis(() =>
		redis.set(
			KEYS.loginOtp(challengeId),
			JSON.stringify({
				userId: existing.id,
				otpHash: otpHash(otp),
				attempts: 0,
				resends: 0,
				ipHash: sha256(ctx.ip),
				uaHash: sha256(ctx.ua),
			} satisfies LoginChallenge),
			"EX",
			ttl,
		),
	);
	await sendLoginOtpEmail(existing.email, otp, Math.round(ttl / 60));
	await logSecurity({ userId: existing.id, type: "OTP_SENT", ctx });

	return {
		newUser: false as const,
		twoFactorRequired: true as const,
		challengeId,
		email: maskEmail(existing.email),
		expiresInSec: ttl,
	};
};

export const googleToken = async (idToken: string, ctx: Ctx) => {
	if (!env.GOOGLE_CLIENT_ID) {
		throw new ApiError(503, "Google login is not configured", [{ code: "SERVICE_UNAVAILABLE" }]);
	}

	const ticket = await googleClient
		.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID })
		.catch(() => null);
	const payload = ticket?.getPayload();

	if (!payload?.sub || !payload.email) {
		throw new ApiError(401, "Invalid Google token", [
			{ code: "TOKEN_INVALID", message: "Invalid Google token" },
		]);
	}

	return handleGoogleProfile(
		{
			googleId: payload.sub,
			email: payload.email.toLowerCase(),
			emailVerified: payload.email_verified !== false,
			name: payload.name ?? payload.email.split("@")[0] ?? "CityCare user",
			avatarUrl: payload.picture,
		},
		ctx,
	);
};
