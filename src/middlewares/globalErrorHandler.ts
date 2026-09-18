import type { ErrorRequestHandler } from "express";
import jwt from "jsonwebtoken";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { isProd } from "@/config/env.js";
import { Prisma } from "@/generated/prisma/client.js";
import { logger } from "@/lib/logger.js";
import { ApiError, type ApiErrorDetail } from "@/utils/ApiError.js";

type Mapped = {
	statusCode: number;
	message: string;
	errors: ApiErrorDetail[];
};

const fromZod = (err: ZodError): Mapped => ({
	statusCode: 400,
	message: "Validation failed",
	errors: err.issues.map((issue) => ({
		field: issue.path.join("."),
		code: "VALIDATION_ERROR",
		message: issue.message,
	})),
});

const fromPrisma = (err: Prisma.PrismaClientKnownRequestError): Mapped => {
	const target = (err.meta?.target as string[] | string | undefined) ?? [];
	const field = Array.isArray(target) ? target.join(", ") : String(target);

	switch (err.code) {
		case "P2002":
			return {
				statusCode: 409,
				message: `${field || "Value"} already exists`,
				errors: [
					{
						field: field || undefined,
						code: field.includes("email") ? "EMAIL_EXISTS" : "CONFLICT",
						message: `${field || "Value"} already exists`,
					},
				],
			};
		case "P2025":
			return {
				statusCode: 404,
				message: "Record not found",
				errors: [{ code: "NOT_FOUND", message: "Record not found" }],
			};
		case "P2003":
			return {
				statusCode: 400,
				message: "Invalid reference id",
				errors: [{ code: "VALIDATION_ERROR", message: "Invalid reference id" }],
			};
		default:
			return {
				statusCode: 400,
				message: "Database request failed",
				errors: [{ code: "VALIDATION_ERROR", message: `Prisma error ${err.code}` }],
			};
	}
};

const fromMulter = (err: MulterError): Mapped => {
	const tooLarge = err.code === "LIMIT_FILE_SIZE";
	return {
		statusCode: tooLarge ? 413 : 400,
		message: tooLarge ? "File too large" : "Invalid file upload",
		errors: [{ field: err.field, code: "PAYLOAD_TOO_LARGE", message: err.message }],
	};
};

const mapError = (err: unknown): Mapped => {
	if (err instanceof ApiError) {
		return { statusCode: err.statusCode, message: err.message, errors: err.errors };
	}
	if (err instanceof ZodError) return fromZod(err);
	if (err instanceof Prisma.PrismaClientKnownRequestError) return fromPrisma(err);
	if (err instanceof Prisma.PrismaClientValidationError) {
		return {
			statusCode: 400,
			message: "Invalid database query",
			errors: [{ code: "VALIDATION_ERROR", message: "Invalid query arguments" }],
		};
	}
	if (err instanceof MulterError) return fromMulter(err);
	if (err instanceof jwt.TokenExpiredError) {
		return {
			statusCode: 401,
			message: "Token expired",
			errors: [{ code: "TOKEN_EXPIRED", message: "Token expired" }],
		};
	}
	if (err instanceof jwt.JsonWebTokenError) {
		return {
			statusCode: 401,
			message: "Invalid token",
			errors: [{ code: "TOKEN_INVALID", message: "Invalid token" }],
		};
	}
	if (err instanceof SyntaxError && "body" in err) {
		return {
			statusCode: 400,
			message: "Malformed JSON body",
			errors: [{ code: "VALIDATION_ERROR", message: "Request body is not valid JSON" }],
		};
	}
	return {
		statusCode: 500,
		message: "Something went wrong",
		errors: [{ code: "INTERNAL_ERROR", message: "Something went wrong" }],
	};
};

/**
 * Last middleware in the chain. Production responses carry a message, a code
 * and the request id — never a stack trace, a SQL fragment or a Prisma string.
 */
export const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
	const { statusCode, message, errors } = mapError(err);

	const log = { err, requestId: req.id, statusCode, path: req.originalUrl, method: req.method };
	if (statusCode >= 500) logger.error(log, "request failed");
	else logger.warn(log, "request rejected");

	res.status(statusCode).json({
		success: false,
		message,
		errors,
		requestId: req.id,
		...(!isProd && statusCode >= 500 && { stack: (err as Error)?.stack }),
	});
};
