import { z } from "zod";

export const createZoneSchema = z.object({
	body: z.object({ name: z.string().trim().min(2).max(80) }).strict(),
});

export type CreateZoneInput = z.infer<typeof createZoneSchema>["body"];
