import { z } from "zod";

export const createDepartmentSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(80),
			email: z.string().trim().email().max(254).optional(),
		})
		.strict(),
});

export const updateDepartmentSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			name: z.string().trim().min(2).max(80).optional(),
			email: z.string().trim().email().max(254).optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export const departmentIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>["body"];
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>["body"];
