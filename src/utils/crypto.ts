import crypto from "node:crypto";
import { env } from "@/config/env.js";

/** Plain SHA-256 hex — used for refresh/reset/device token lookups. */
export const sha256 = (value: string): string =>
	crypto.createHash("sha256").update(value).digest("hex");

/**
 * OTPs are stored keyed (HMAC), never plain and never plain-SHA256:
 * a leaked Redis dump must not be brute-forceable offline for 6 digits.
 */
export const otpHash = (otp: string): string =>
	crypto.createHmac("sha256", env.OTP_SECRET).update(otp).digest("hex");

/** Constant-time comparison for anything secret. */
export const safeEqual = (a: string, b: string): boolean => {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
};

/** Cryptographically strong 6-digit OTP (100000–999999). */
export const randomOtp = (): string => crypto.randomInt(100_000, 1_000_000).toString();

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString("hex");

/** a***n@gmail.com — enough for the user to recognise, useless for an attacker. */
export const maskEmail = (email: string): string => {
	const [local = "", domain = ""] = email.split("@");
	if (!domain) return "***";
	if (local.length <= 2) return `${local.charAt(0)}***@${domain}`;
	return `${local.charAt(0)}${"*".repeat(Math.min(local.length - 2, 5))}${local.slice(-1)}@${domain}`;
};

/** Stable hash of a request body, for the Idempotency-Key middleware. */
export const hashBody = (body: unknown): string => sha256(JSON.stringify(body ?? {}));
