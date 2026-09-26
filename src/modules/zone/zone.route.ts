import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as ZoneController from "@/modules/zone/zone.controller.js";
import { createZoneSchema } from "@/modules/zone/zone.validation.js";

export const zoneRoutes: Router = Router();

zoneRoutes.get("/", ZoneController.list);
zoneRoutes.post(
	"/",
	auth,
	authorize("ADMIN"),
	adminLimiter,
	requirePermission(PERMISSIONS.taxonomy__manage_zones),
	validateRequest(createZoneSchema),
	ZoneController.create,
);
