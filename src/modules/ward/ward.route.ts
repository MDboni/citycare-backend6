import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as WardController from "@/modules/ward/ward.controller.js";
import * as V from "@/modules/ward/ward.validation.js";

export const wardRoutes: Router = Router();

wardRoutes.get("/", WardController.list);

// authorize keeps this staff-only; requirePermission decides which staff.
wardRoutes.use(
	auth,
	authorize("ADMIN"),
	adminLimiter,
	requirePermission(PERMISSIONS.taxonomy__manage_wards),
);

wardRoutes.post("/", validateRequest(V.createWardSchema), WardController.create);
wardRoutes.patch("/:id", validateRequest(V.updateWardSchema), WardController.update);
