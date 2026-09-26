import { z } from "zod";

/**
 * A permission code is a stable identifier a route guard points at, so it is
 * deliberately narrow: lower snake case, optionally with the `category__action`
 * double underscore. Letting spaces or capitals in would mean two codes that
 * look identical in the table and behave differently.
 */
const permissionCode = z
	.string()
	.trim()
	.min(3)
	.max(80)
	.regex(/^[a-z][a-z0-9]*(?:_{1,2}[a-z0-9]+)*$/, {
		message: "Use lower snake case, e.g. complaints__assign",
	});

export const listPermissionsSchema = z.object({
	query: z
		.object({
			category: z.string().trim().max(60).optional(),
			search: z.string().trim().max(80).optional(),
		})
		.strict()
		.optional(),
});

export const createPermissionSchema = z.object({
	body: z
		.object({
			code: permissionCode,
			name: z.string().trim().min(2).max(120),
			description: z.string().trim().max(400).optional(),
			category: z.string().trim().min(2).max(60),
		})
		.strict(),
});

export const updatePermissionSchema = z.object({
	params: z.object({ id: z.uuid() }),
	// No `code`: routes reference it, so renaming one silently breaks a guard.
	body: z
		.object({
			name: z.string().trim().min(2).max(120).optional(),
			description: z.string().trim().max(400).optional(),
			category: z.string().trim().min(2).max(60).optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export const createRoleSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(60),
			description: z.string().trim().max(400).optional(),
			permissionIds: z.array(z.uuid()).max(200).default([]),
		})
		.strict(),
});

export const updateRoleSchema = z.object({
	params: z.object({ id: z.uuid() }),
	body: z
		.object({
			name: z.string().trim().min(2).max(60).optional(),
			description: z.string().trim().max(400).optional(),
			/** Present means "this is the whole set now", absent means "leave it". */
			permissionIds: z.array(z.uuid()).max(200).optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export const assignUserRolesSchema = z.object({
	params: z.object({ id: z.uuid() }),
	body: z
		.object({
			roleIds: z.array(z.uuid()).max(20),
		})
		.strict(),
});

export const idSchema = z.object({ params: z.object({ id: z.uuid() }) });

export type CreatePermissionInput = z.infer<typeof createPermissionSchema>["body"];
export type UpdatePermissionInput = z.infer<typeof updatePermissionSchema>["body"];
export type CreateRoleInput = z.infer<typeof createRoleSchema>["body"];
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>["body"];
