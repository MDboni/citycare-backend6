import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission } from "@/middlewares/authorize.js";
import { uploadDocument, verifyDocument } from "@/middlewares/upload.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/serviceRequest/serviceRequest.controller.js";
import * as V from "@/modules/serviceRequest/serviceRequest.validation.js";

export const serviceRequestRoutes: Router = Router();

serviceRequestRoutes.use(auth);

serviceRequestRoutes.post(
	"/",
	authorize("CITIZEN"),
	validateRequest(V.createServiceRequestSchema),
	C.create,
);
serviceRequestRoutes.get(
	"/my",
	authorize("CITIZEN"),
	validateRequest(V.listServiceRequestsSchema),
	C.listMine,
);
serviceRequestRoutes.get(
	"/",
	authorize("ADMIN", "OFFICER"),
	requirePermission(PERMISSIONS.service_requests__view_all),
	validateRequest(V.listServiceRequestsSchema),
	C.list,
);
serviceRequestRoutes.get("/:id", validateRequest(V.serviceRequestIdSchema), C.getById);
serviceRequestRoutes.patch(
	"/:id/status",
	authorize("ADMIN", "OFFICER"),
	requirePermission(PERMISSIONS.service_requests__process),
	validateRequest(V.updateServiceRequestStatusSchema),
	C.updateStatus,
);
serviceRequestRoutes.post(
	"/:id/documents",
	authorize("CITIZEN"),
	uploadDocument.single("document"),
	verifyDocument,
	validateRequest(V.uploadDocumentSchema),
	C.addDocument,
);
serviceRequestRoutes.get(
	"/:id/documents/:docId",
	validateRequest(V.documentIdSchema),
	C.getDocument,
);
