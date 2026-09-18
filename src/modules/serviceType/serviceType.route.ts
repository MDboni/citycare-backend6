import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { authorize } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as ServiceTypeController from "@/modules/serviceType/serviceType.controller.js";
import * as V from "@/modules/serviceType/serviceType.validation.js";

export const serviceTypeRoutes: Router = Router();

serviceTypeRoutes.get("/", ServiceTypeController.list);

serviceTypeRoutes.use(auth, authorize("ADMIN"), adminLimiter);

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
