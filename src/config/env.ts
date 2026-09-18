import "dotenv/config";
import { z } from "zod";

/**
 * The ONLY place in the codebase allowed to touch `process.env`.
 * Everything else imports `env` from here, so a missing key crashes the
 * process at startup instead of throwing `undefined` somewhere at 2 a.m.
 */
const envSchema = z.object({
	// --- runtime -----------------------------------------------------------
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().default(5000),
	BACKEND_URL: z.string().min(1).default("http://localhost:5000"),
	CLIENT_URL: z.string().min(1).default("http://localhost:3000"),

	// --- database ----------------------------------------------------------
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	TEST_DATABASE_URL: z.string().optional(),

	// --- auth (three different secrets, never reuse one) --------------------
	JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
	JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
	JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
	JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
	OTP_SECRET: z.string().min(32, "OTP_SECRET must be at least 32 characters"),
	BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

	// --- google oauth (optional: login simply stays unavailable) ------------
	GOOGLE_CLIENT_ID: z.string().default(""),
	GOOGLE_CLIENT_SECRET: z.string().default(""),
	GOOGLE_CALLBACK_URL: z.string().default("http://localhost:5000/api/v1/auth/google/callback"),

	// --- sslcommerz sandbox -------------------------------------------------
	SSL_STORE_ID: z.string().default(""),
	SSL_STORE_PASSWORD: z.string().default(""),
	SSL_IS_LIVE: z
		.string()
		.default("false")
		.transform((v) => v === "true"),

	// --- cloudinary ---------------------------------------------------------
	CLOUDINARY_CLOUD_NAME: z.string().default(""),
	CLOUDINARY_API_KEY: z.string().default(""),
	CLOUDINARY_API_SECRET: z.string().default(""),

	// --- redis: either a full URL or host/port pieces ------------------------
	REDIS_URL: z.string().default(""),
	REDIS_HOST: z.string().default(""),
	REDIS_PORT: z.coerce.number().int().positive().default(6379),
	REDIS_USERNAME: z.string().default(""),
	REDIS_PASSWORD: z.string().default(""),

	// --- email --------------------------------------------------------------
	SMTP_HOST: z.string().default("smtp.gmail.com"),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().default(""),
	SMTP_PASS: z.string().default(""),
	EMAIL_FROM: z.string().default("CityCare <no-reply@citycare.com>"),

	// --- rate limits ---------------------------------------------------------
	// The defaults are the production posture. Raise them for a demo or a
	// walkthrough, where one evaluator's IP legitimately makes a hundred calls.
	RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(100),
	RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(5),

	// --- seed ---------------------------------------------------------------
	ADMIN_EMAIL: z.string().default("admin@citycare.com"),
	ADMIN_PASSWORD: z.string().default("Admin@12345"),
	SUPER_ADMIN_EMAIL: z.string().default("admin@citycare.com"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
	// Logger is not up yet, and the process is about to die anyway.
	console.error(`\nInvalid environment configuration:\n${lines.join("\n")}\n`);
	console.error("Copy .env.example to .env and fill in the missing values.\n");
	process.exit(1);
}

export const env = parsed.data;

export type Env = typeof env;

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const isDev = env.NODE_ENV === "development";

/** Comma separated CORS whitelist, e.g. CLIENT_URL="http://a.com,http://b.com" */
export const corsOrigins = env.CLIENT_URL.split(",")
	.map((o) => o.trim())
	.filter(Boolean);
