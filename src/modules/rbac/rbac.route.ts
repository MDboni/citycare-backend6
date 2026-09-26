import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/rbac/rbac.controller.js";
import * as V from "@/modules/rbac/rbac.validation.js";

export const rbacRoutes: Router = Router();

/**
 * Every signed-in account may ask what it can do. This one sits above the
 * staff gate on purpose: the console calls it before it knows whether to show
 * a single menu item, and a citizen simply gets an empty list.
 */
rbacRoutes.get("/me/permissions", auth, C.myPermissions);

// Everything below is the access-control screen itself.
rbacRoutes.use(auth, authorize("ADMIN"), adminLimiter);

// ── permissions ─────────────────────────────────────────────────────────────
rbacRoutes.get(
	"/permissions",
	requirePermission(
		PERMISSIONS.access_control__manage_permissions,
		PERMISSIONS.access_control__manage_roles,
	),
	validateRequest(V.listPermissionsSchema),
	C.listPermissions,
);
rbacRoutes.post(
	"/permissions",
	requirePermission(PERMISSIONS.access_control__manage_permissions),
	validateRequest(V.createPermissionSchema),
	C.createPermission,
);
rbacRoutes.patch(
	"/permissions/:id",
	requirePermission(PERMISSIONS.access_control__manage_permissions),
	validateRequest(V.updatePermissionSchema),
	C.updatePermission,
);
rbacRoutes.delete(
	"/permissions/:id",
	requirePermission(PERMISSIONS.access_control__manage_permissions),
	validateRequest(V.idSchema),
	C.deletePermission,
);

// ── roles ───────────────────────────────────────────────────────────────────
rbacRoutes.get(
	"/roles",
	requirePermission(
		PERMISSIONS.access_control__manage_roles,
		PERMISSIONS.access_control__manage_users,
	),
	C.listRoles,
);
rbacRoutes.post(
	"/roles",
	requirePermission(PERMISSIONS.access_control__manage_roles),
	validateRequest(V.createRoleSchema),
	C.createRole,
);
rbacRoutes.patch(
	"/roles/:id",
	requirePermission(PERMISSIONS.access_control__manage_roles),
	validateRequest(V.updateRoleSchema),
	C.updateRole,
);
rbacRoutes.delete(
	"/roles/:id",
	requirePermission(PERMISSIONS.access_control__manage_roles),
	validateRequest(V.idSchema),
	C.deleteRole,
);

// ── assignment ──────────────────────────────────────────────────────────────
rbacRoutes.get(
	"/users/:id/roles",
	requirePermission(PERMISSIONS.access_control__manage_users),
	validateRequest(V.idSchema),
	C.getUserRoles,
);
rbacRoutes.put(
	"/users/:id/roles",
	requirePermission(PERMISSIONS.access_control__manage_users),
	validateRequest(V.assignUserRolesSchema),
	C.assignUserRoles,
);
