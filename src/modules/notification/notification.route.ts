import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as NotificationController from "@/modules/notification/notification.controller.js";
import * as V from "@/modules/notification/notification.validation.js";

export const notificationRoutes: Router = Router();

notificationRoutes.use(auth);

notificationRoutes.get(
	"/",
	validateRequest(V.listNotificationsSchema),
	NotificationController.list,
);
notificationRoutes.patch("/read-all", NotificationController.markAllRead);
notificationRoutes.patch(
	"/:id/read",
	validateRequest(V.notificationIdSchema),
	NotificationController.markRead,
);
