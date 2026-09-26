import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as DepartmentController from "@/modules/department/department.controller.js";
import * as V from "@/modules/department/department.validation.js";

export const departmentRoutes: Router = Router();

// Public, cached.
departmentRoutes.get("/", DepartmentController.list);

// authorize keeps this staff-only; requirePermission decides which staff.
departmentRoutes.use(
	auth,
	authorize("ADMIN"),
	adminLimiter,
	requirePermission(PERMISSIONS.taxonomy__manage_departments),
);

departmentRoutes.post("/", validateRequest(V.createDepartmentSchema), DepartmentController.create);
departmentRoutes.patch(
	"/:id",
	validateRequest(V.updateDepartmentSchema),
	DepartmentController.update,
);
departmentRoutes.delete("/:id", validateRequest(V.departmentIdSchema), DepartmentController.remove);
