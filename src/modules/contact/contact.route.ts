import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter, contactLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/contact/contact.controller.js";
import * as V from "@/modules/contact/contact.validation.js";

export const contactRoutes: Router = Router();

/**
 * The only unauthenticated write in the API that is not part of signing in, so
 * it gets its own rate limit rather than spending the global budget: a form
 * anyone can POST to is a spam target, and the limiter is the whole defence.
 */
contactRoutes.post("/", contactLimiter, validateRequest(V.createContactMessageSchema), C.create);

// Everything below is the console's inbox.
contactRoutes.use(auth, authorize("ADMIN"), adminLimiter);

contactRoutes.get(
	"/",
	requirePermission(PERMISSIONS.contact__manage_messages),
	validateRequest(V.listContactMessagesSchema),
	C.list,
);
contactRoutes.get(
	"/:id",
	requirePermission(PERMISSIONS.contact__manage_messages),
	validateRequest(V.contactMessageIdSchema),
	C.getById,
);
contactRoutes.patch(
	"/:id",
	requirePermission(PERMISSIONS.contact__manage_messages),
	validateRequest(V.updateContactMessageSchema),
	C.update,
);
