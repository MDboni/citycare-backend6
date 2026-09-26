import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as CategoryController from "@/modules/category/category.controller.js";
import * as V from "@/modules/category/category.validation.js";

export const categoryRoutes: Router = Router();

categoryRoutes.get("/", CategoryController.list);

// authorize keeps this staff-only; requirePermission decides which staff.
categoryRoutes.use(
	auth,
	authorize("ADMIN"),
	adminLimiter,
	requirePermission(PERMISSIONS.taxonomy__manage_categories),
);

categoryRoutes.post("/", validateRequest(V.createCategorySchema), CategoryController.create);
categoryRoutes.patch("/:id", validateRequest(V.updateCategorySchema), CategoryController.update);
categoryRoutes.delete("/:id", validateRequest(V.categoryIdSchema), CategoryController.remove);
