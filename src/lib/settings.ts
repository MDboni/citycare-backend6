import { logger } from "@/lib/logger.js";
import { prisma } from "@/lib/prisma.js";

/**
 * Runtime knobs live in the SystemSetting table so a super admin can change
 * them without a deploy. The defaults here are the contract: if the row is
 * missing or Postgres is briefly unavailable, behaviour stays predictable.
 */
export const SETTING_DEFAULTS = {
	REOPEN_LIMIT: 2,
	REOPEN_WINDOW_DAYS: 7,
	URGENT_SLA_FACTOR: 0.5,
	LOGIN_OTP_TTL_SEC: 300,
	SIGNUP_OTP_TTL_SEC: 600,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

const cache = new Map<SettingKey, { value: number; expires: number }>();
const TTL_MS = 60_000;

export const getSetting = async (key: SettingKey): Promise<number> => {
	const hit = cache.get(key);
	if (hit && hit.expires > Date.now()) return hit.value;

	try {
		const row = await prisma.systemSetting.findUnique({ where: { key } });
		const parsed = Number(row?.value);
		const value = Number.isFinite(parsed) ? parsed : SETTING_DEFAULTS[key];
		cache.set(key, { value, expires: Date.now() + TTL_MS });
		return value;
	} catch (err) {
		logger.warn({ err, key }, "setting lookup failed, using default");
		return SETTING_DEFAULTS[key];
	}
};

/** Called after PATCH /admin/settings/:key so the change takes effect at once. */
export const clearSettingCache = (key?: SettingKey): void => {
	if (key) cache.delete(key);
	else cache.clear();
};
