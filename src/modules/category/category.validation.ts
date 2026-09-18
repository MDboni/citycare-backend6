import { z } from "zod";

const priority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const createCategorySchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(80),
			departmentId: z.string().uuid(),
			slaHours: z.number().int().min(1).max(8760).default(72),
			defaultPriority: priority.default("MEDIUM"),
		})
		.strict(),
});

export const updateCategorySchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			name: z.string().trim().min(2).max(80).optional(),
			departmentId: z.string().uuid().optional(),
			slaHours: z.number().int().min(1).max(8760).optional(),
			defaultPriority: priority.optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export const categoryIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>["body"];
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>["body"];
