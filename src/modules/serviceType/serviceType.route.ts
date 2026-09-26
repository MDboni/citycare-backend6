import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as ServiceTypeController from "@/modules/serviceType/serviceType.controller.js";
import * as V from "@/modules/serviceType/serviceType.validation.js";

export const serviceTypeRoutes: Router = Router();

serviceTypeRoutes.get("/", ServiceTypeController.list);

// authorize keeps this staff-only; requirePermission decides which staff.
serviceTypeRoutes.use(
	auth,
	authorize("ADMIN"),
	adminLimiter,
	requirePermission(PERMISSIONS.taxonomy__manage_service_types),
);

serviceTypeRoutes.post(
	"/",
	validateRequest(V.createServiceTypeSchema),
	ServiceTypeController.create,
);
serviceTypeRoutes.patch(
	"/:id",
	validateRequest(V.updateServiceTypeSchema),
	ServiceTypeController.update,
);
