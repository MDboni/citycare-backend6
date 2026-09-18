import { z } from "zod";

export const listNotificationsSchema = z.object({
	query: z
		.object({
			page: z.coerce.number().int().min(1).optional(),
			limit: z.coerce.number().int().min(1).optional(),
			unread: z
				.enum(["true", "false"])
				.optional()
				.transform((v) => v === "true"),
		})
		.strict(),
});

export const notificationIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});
