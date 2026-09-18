import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { authorize } from "@/middlewares/authorize.js";
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
	validateRequest(createZoneSchema),
	ZoneController.create,
);
