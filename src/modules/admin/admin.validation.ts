import { z } from "zod";

const password = z
	.string()
	.min(10)
	.max(128)
	.regex(/[a-z]/, "Password needs a lowercase letter")
	.regex(/[A-Z]/, "Password needs an uppercase letter")
	.regex(/[0-9]/, "Password needs a number")
	.regex(/[^A-Za-z0-9]/, "Password needs a symbol");

const email = z.string().trim().toLowerCase().email().max(254);

export const listUsersSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			role: z.enum(["CITIZEN", "OFFICER", "ADMIN"]).optional(),
			status: z.enum(["ACTIVE", "BLOCKED"]).optional(),
			q: z.string().trim().max(120).optional(),
			sortBy: z.string().optional(),
			sortOrder: z.enum(["asc", "desc"]).optional(),
		})
		.strict(),
});

export const createOfficerSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(80),
			email,
			phone: z.string().trim().max(20).optional(),
			departmentId: z.string().uuid(),
			wardId: z.string().uuid().optional(),
		})
		.strict(),
});

export const createAdminSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(80),
			email,
			password,
		})
		.strict(),
});

export const userIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export const updateRoleSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	// `isSuperAdmin` is absent on purpose: no API may ever set it.
	body: z.object({ role: z.enum(["CITIZEN", "OFFICER", "ADMIN"]) }).strict(),
});

export const updateStatusSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			status: z.enum(["ACTIVE", "BLOCKED"]),
			reason: z.string().trim().max(300).optional(),
		})
		.strict(),
});

export const restoreSchema = z.object({
	params: z.object({
		entity: z.enum(["complaint", "user", "category", "department"]),
		id: z.string().uuid(),
	}),
});

export const auditLogsSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			actorId: z.string().uuid().optional(),
			action: z.string().trim().max(60).optional(),
			entityType: z.string().trim().max(60).optional(),
			from: z.string().optional(),
			to: z.string().optional(),
			sortBy: z.string().optional(),
			sortOrder: z.enum(["asc", "desc"]).optional(),
		})
		.strict(),
});

export const securityEventsSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			type: z
				.enum([
					"LOGIN_SUCCESS",
					"LOGIN_FAILED",
					"OTP_SENT",
					"OTP_FAILED",
					"ACCOUNT_LOCKED",
					"NEW_DEVICE",
					"TOKEN_REUSE",
					"PASSWORD_CHANGED",
					"TWO_FA_TOGGLED",
					"ROLE_CHANGED",
					"SESSION_REVOKED",
				])
				.optional(),
			ip: z.string().trim().max(64).optional(),
			from: z.string().optional(),
			to: z.string().optional(),
		})
		.strict(),
});

export const csvReportSchema = z.object({
	query: z
		.object({
			status: z.string().optional(),
			wardId: z.string().uuid().optional(),
			categoryId: z.string().uuid().optional(),
			from: z.string().optional(),
			to: z.string().optional(),
		})
		.strict(),
});

export const settingKeySchema = z.object({
	params: z.object({
		key: z.enum([
			"REOPEN_LIMIT",
			"REOPEN_WINDOW_DAYS",
			"URGENT_SLA_FACTOR",
			"LOGIN_OTP_TTL_SEC",
			"SIGNUP_OTP_TTL_SEC",
		]),
	}),
	body: z.object({ value: z.number() }).strict(),
});

export type ListUsersQuery = z.infer<typeof listUsersSchema>["query"];
export type CreateOfficerInput = z.infer<typeof createOfficerSchema>["body"];
export type CreateAdminInput = z.infer<typeof createAdminSchema>["body"];
export type AuditLogsQuery = z.infer<typeof auditLogsSchema>["query"];
export type SecurityEventsQuery = z.infer<typeof securityEventsSchema>["query"];
export type CsvReportQuery = z.infer<typeof csvReportSchema>["query"];
