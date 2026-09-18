export type ApiErrorDetail = {
	field?: string;
	code?: string;
	message?: string;
};

/**
 * The only error type services and controllers are allowed to throw.
 * `statusCode` + `errors[]` map straight onto the mandatory error envelope.
 */
export class ApiError extends Error {
	public readonly statusCode: number;
	public readonly errors: ApiErrorDetail[];

	constructor(statusCode: number, message: string, errors: ApiErrorDetail[] = []) {
		super(message);
		this.name = "ApiError";
		this.statusCode = statusCode;
		this.errors = errors.length ? errors : [{ message }];
		Error.captureStackTrace?.(this, ApiError);
	}
}

/** Shorthand builders for the codes listed in the error-code catalog. */
export const badRequest = (message: string, code = "VALIDATION_ERROR") =>
	new ApiError(400, message, [{ code, message }]);

export const unauthorized = (message: string, code = "TOKEN_MISSING") =>
	new ApiError(401, message, [{ code, message }]);

export const forbidden = (message: string, code = "FORBIDDEN_ROLE") =>
	new ApiError(403, message, [{ code, message }]);

export const notFoundError = (message = "Resource not found", code = "NOT_FOUND") =>
	new ApiError(404, message, [{ code, message }]);

export const conflict = (message: string, code = "CONFLICT") =>
	new ApiError(409, message, [{ code, message }]);

export const tooManyRequests = (message: string, code = "RATE_LIMITED") =>
	new ApiError(429, message, [{ code, message }]);
