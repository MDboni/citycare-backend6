import { z } from "zod";

export const updateMeSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(80).optional(),
			phone: z.string().trim().max(20).optional(),
			wardId: z.string().uuid().optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>["body"];
