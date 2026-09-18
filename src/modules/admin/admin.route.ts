import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { authorize, superAdminOnly } from "@/middlewares/authorize.js";
import { adminLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/admin/admin.controller.js";
import * as V from "@/modules/admin/admin.validation.js";

export const adminRoutes: Router = Router();

adminRoutes.use(auth, authorize("ADMIN"), adminLimiter);

// --- users -----------------------------------------------------------------
adminRoutes.get("/users", validateRequest(V.listUsersSchema), C.listUsers);
adminRoutes.post("/officers", validateRequest(V.createOfficerSchema), C.createOfficer);
adminRoutes.patch("/users/:id/role", validateRequest(V.updateRoleSchema), C.updateRole);
adminRoutes.patch("/users/:id/status", validateRequest(V.updateStatusSchema), C.updateStatus);
adminRoutes.delete("/users/:id/sessions", validateRequest(V.userIdSchema), C.forceLogout);

// --- super admin only ------------------------------------------------------
adminRoutes.post("/admins", superAdminOnly, validateRequest(V.createAdminSchema), C.createAdmin);
adminRoutes.delete("/admins/:id", superAdminOnly, validateRequest(V.userIdSchema), C.removeAdmin);
adminRoutes.patch(
	"/restore/:entity/:id",
	superAdminOnly,
	validateRequest(V.restoreSchema),
	C.restore,
);
adminRoutes.get(
	"/security-events",
	superAdminOnly,
	validateRequest(V.securityEventsSchema),
	C.securityEvents,
);
adminRoutes.patch(
	"/settings/:key",
	superAdminOnly,
	validateRequest(V.settingKeySchema),
	C.updateSetting,
);

// --- dashboards and reports ------------------------------------------------
adminRoutes.get("/dashboard-stats", C.dashboardStats);
adminRoutes.get("/audit-logs", validateRequest(V.auditLogsSchema), C.auditLogs);
adminRoutes.get("/reports/sla", C.slaReport);
adminRoutes.get("/reports/complaints.csv", validateRequest(V.csvReportSchema), C.complaintsCsv);
adminRoutes.get("/settings", C.listSettings);

// --- officer ---------------------------------------------------------------
export const officerRoutes: Router = Router();
officerRoutes.get("/stats", auth, authorize("OFFICER"), C.officerStats);
