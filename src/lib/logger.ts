import pino from "pino";
import { env, isDev, isTest } from "@/config/env.js";

/**
 * Secrets must never reach the log stream — this list is the last line of
 * defence behind "don't log secrets in the first place".
 */
export const REDACT_PATHS = [
	"req.headers.authorization",
	"req.headers.cookie",
	"res.headers['set-cookie']",
	"*.password",
	"*.passwordHash",
	"*.otp",
	"*.otpHash",
	"*.token",
	"*.tokenHash",
	"*.refreshToken",
	"*.accessToken",
	"*.deviceToken",
	"*.idToken",
	"*.val_id",
];

export const logger = pino({
	level: isTest ? "silent" : isDev ? "debug" : "info",
	redact: { paths: REDACT_PATHS, censor: "[redacted]" },
	base: { service: "citycare-api", env: env.NODE_ENV },
	timestamp: pino.stdTimeFunctions.isoTime,
	...(isDev && {
		transport: {
			target: "pino-pretty",
			options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service,env" },
		},
	}),
});

export type Logger = typeof logger;
