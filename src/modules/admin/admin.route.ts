import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission, superAdminOnly } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/admin/admin.controller.js";
import * as V from "@/modules/admin/admin.validation.js";

export const adminRoutes: Router = Router();

adminRoutes.use(auth, authorize("ADMIN"), adminLimiter);

// --- users -----------------------------------------------------------------
adminRoutes.get(
	"/users",
	requirePermission(PERMISSIONS.users__view),
	validateRequest(V.listUsersSchema),
	C.listUsers,
);
adminRoutes.post(
	"/officers",
	requirePermission(PERMISSIONS.users__create_officer),
	validateRequest(V.createOfficerSchema),
	C.createOfficer,
);
adminRoutes.patch(
	"/users/:id/role",
	requirePermission(PERMISSIONS.users__change_role),
	validateRequest(V.updateRoleSchema),
	C.updateRole,
);
adminRoutes.patch(
	"/users/:id/status",
	requirePermission(PERMISSIONS.users__change_status),
	validateRequest(V.updateStatusSchema),
	C.updateStatus,
);
adminRoutes.delete(
	"/users/:id/sessions",
	requirePermission(PERMISSIONS.users__force_logout),
	validateRequest(V.userIdSchema),
	C.forceLogout,
);

// --- super admin only ------------------------------------------------------
adminRoutes.post(
	"/admins",
	superAdminOnly,
	requirePermission(PERMISSIONS.users__create_admin),
	validateRequest(V.createAdminSchema),
	C.createAdmin,
);
adminRoutes.delete(
	"/admins/:id",
	superAdminOnly,
	requirePermission(PERMISSIONS.users__remove_admin),
	validateRequest(V.userIdSchema),
	C.removeAdmin,
);
adminRoutes.patch(
	"/restore/:entity/:id",
	superAdminOnly,
	validateRequest(V.restoreSchema),
	C.restore,
);
adminRoutes.get(
	"/security-events",
	superAdminOnly,
	requirePermission(PERMISSIONS.oversight__view_security_events),
	validateRequest(V.securityEventsSchema),
	C.securityEvents,
);
adminRoutes.patch(
	"/settings/:key",
	superAdminOnly,
	requirePermission(PERMISSIONS.oversight__manage_settings),
	validateRequest(V.settingKeySchema),
	C.updateSetting,
);

// --- dashboards and reports ------------------------------------------------
adminRoutes.get(
	"/dashboard-stats",
	requirePermission(PERMISSIONS.oversight__view_dashboard),
	C.dashboardStats,
);
adminRoutes.get(
	"/audit-logs",
	requirePermission(PERMISSIONS.oversight__view_audit_logs),
	validateRequest(V.auditLogsSchema),
	C.auditLogs,
);
adminRoutes.get(
	"/reports/sla",
	requirePermission(PERMISSIONS.oversight__view_reports),
	C.slaReport,
);
adminRoutes.get(
	"/reports/complaints.csv",
	requirePermission(PERMISSIONS.oversight__view_reports),
	validateRequest(V.csvReportSchema),
	C.complaintsCsv,
);
adminRoutes.get("/settings", C.listSettings);

// --- officer ---------------------------------------------------------------
export const officerRoutes: Router = Router();
officerRoutes.get("/stats", auth, authorize("OFFICER"), C.officerStats);
