import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { authorize } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as WardController from "@/modules/ward/ward.controller.js";
import * as V from "@/modules/ward/ward.validation.js";

export const wardRoutes: Router = Router();

wardRoutes.get("/", WardController.list);

wardRoutes.use(auth, authorize("ADMIN"), adminLimiter);

wardRoutes.post("/", validateRequest(V.createWardSchema), WardController.create);
wardRoutes.patch("/:id", validateRequest(V.updateWardSchema), WardController.update);
