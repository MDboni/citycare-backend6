import bcrypt from "bcryptjs";

/** Redis key builders — one place, so a typo cannot create an orphan key. */
export const KEYS = {
	pendingSignup: (email: string) => `reg:pending:${email}`,
	otpCooldown: (email: string) => `otp:cooldown:${email}`,
	otpSends: (email: string) => `otp:sends:${email}`,
	loginFail: (email: string) => `login:fail:${email}`,
	loginIp: (ip: string) => `login:ip:${ip}`,
	loginOtp: (challengeId: string) => `login:otp:${challengeId}`,
	passwordReset: (tokenHash: string) => `pwd:reset:${tokenHash}`,
	jwtDeny: (jti: string) => `jwt:deny:${jti}`,
	session: (sid: string) => `sess:${sid}`,
	loginFailIpAlert: (ip: string) => `login:ipalert:${ip}`,
} as const;

export const TTL = {
	/** Pending signup lives 10 minutes; nothing is written to Postgres before that. */
	pendingSignup: 600,
	otpCooldown: 60,
	otpSends: 3600,
	loginFail: 900,
	loginFailLong: 3600,
	loginIp: 900,
	loginOtp: 300,
	passwordReset: 900,
	trustedDeviceDays: 30,
	refreshDays: 7,
	superAdminSessionHours: 8,
} as const;

export const LIMITS = {
	otpSendsPerHour: 5,
	signupOtpAttempts: 5,
	loginOtpAttempts: 5,
	loginOtpResends: 3,
	loginFailBeforeLock: 5,
	loginFailBeforeLongLock: 10,
	loginFailPerIp: 30,
	ipAlertThreshold: 20,
} as const;

/**
 * Compared against when the email is unknown, so a "no such user" answer takes
 * the same time as a wrong password. Enumeration is a timing problem too.
 */
export const DUMMY_HASH = bcrypt.hashSync("citycare-dummy-password-for-timing", 12);

export const REVOKE_REASON = {
	LOGOUT: "LOGOUT",
	PASSWORD_CHANGED: "PASSWORD_CHANGED",
	TOKEN_REUSE: "TOKEN_REUSE",
	ADMIN: "ADMIN",
	ROLE_CHANGED: "ROLE_CHANGED",
} as const;

/** Never leak which half of the credential pair was wrong. */
export const GENERIC_INVALID_CREDENTIALS = "Invalid credentials";
