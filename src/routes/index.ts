import { Router } from "express";
import { mountSwagger } from "@/lib/swagger.js";
import { adminRoutes, officerRoutes } from "@/modules/admin/admin.route.js";
import { authRoutes } from "@/modules/auth/auth.route.js";
import { categoryRoutes } from "@/modules/category/category.route.js";
import { complaintRoutes } from "@/modules/complaint/complaint.route.js";
import { departmentRoutes } from "@/modules/department/department.route.js";
import { notificationRoutes } from "@/modules/notification/notification.route.js";
import { paymentRoutes } from "@/modules/payment/payment.route.js";
import { serviceRequestRoutes } from "@/modules/serviceRequest/serviceRequest.route.js";
import { serviceTypeRoutes } from "@/modules/serviceType/serviceType.route.js";
import { userRoutes } from "@/modules/user/user.route.js";
import { wardRoutes } from "@/modules/ward/ward.route.js";
import { zoneRoutes } from "@/modules/zone/zone.route.js";

export const router: Router = Router();

/** Every module router is mounted here — app.ts never imports a module. */
const modules: { path: string; route: Router }[] = [
	{ path: "/auth", route: authRoutes },
	{ path: "/users", route: userRoutes },
	{ path: "/departments", route: departmentRoutes },
	{ path: "/categories", route: categoryRoutes },
	{ path: "/wards", route: wardRoutes },
	{ path: "/zones", route: zoneRoutes },
	{ path: "/service-types", route: serviceTypeRoutes },
	{ path: "/complaints", route: complaintRoutes },
	{ path: "/service-requests", route: serviceRequestRoutes },
	{ path: "/payments", route: paymentRoutes },
	{ path: "/notifications", route: notificationRoutes },
	{ path: "/admin", route: adminRoutes },
	{ path: "/officer", route: officerRoutes },
];

for (const m of modules) router.use(m.path, m.route);

// Served at /api/v1/docs from the hand-written docs/openapi.yaml.
// Top-level await: the docs are mounted before the server starts listening.
await mountSwagger(router);
