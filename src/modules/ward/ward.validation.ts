import { z } from "zod";

export const createWardSchema = z.object({
	body: z
		.object({
			number: z.number().int().min(1).max(1000),
			name: z.string().trim().min(2).max(80),
			zoneId: z.string().uuid().optional(),
		})
		.strict(),
});

export const updateWardSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			number: z.number().int().min(1).max(1000).optional(),
			name: z.string().trim().min(2).max(80).optional(),
			zoneId: z.string().uuid().optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export type CreateWardInput = z.infer<typeof createWardSchema>["body"];
export type UpdateWardInput = z.infer<typeof updateWardSchema>["body"];
