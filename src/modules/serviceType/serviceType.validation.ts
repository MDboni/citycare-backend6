import { z } from "zod";

/** Money arrives as a string so no float ever touches a fee. */
const fee = z
	.string()
	.trim()
	.regex(/^\d{1,8}(\.\d{1,2})?$/, "Fee must look like 500 or 500.00");

export const createServiceTypeSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(120),
			fee,
			isActive: z.boolean().default(true),
		})
		.strict(),
});

export const updateServiceTypeSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
	body: z
		.object({
			name: z.string().trim().min(2).max(120).optional(),
			fee: fee.optional(),
			isActive: z.boolean().optional(),
		})
		.strict()
		.refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }),
});

export type CreateServiceTypeInput = z.infer<typeof createServiceTypeSchema>["body"];
export type UpdateServiceTypeInput = z.infer<typeof updateServiceTypeSchema>["body"];
