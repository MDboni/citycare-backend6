import { Router } from "express";
import { PERMISSIONS } from "@/config/permissions.js";
import { auth } from "@/middlewares/auth.js";
import { authorize, requirePermission, superAdminOnly } from "@/middlewares/authorize.js";
import { idempotency } from "@/middlewares/idempotency.js";
import { callbackLimiter, paymentLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/payment/payment.controller.js";
import * as V from "@/modules/payment/payment.validation.js";

export const paymentRoutes: Router = Router();

// --- gateway callbacks: public, rate limited, never trusted -----------------
paymentRoutes.post("/success", callbackLimiter, C.success);
paymentRoutes.post("/fail", callbackLimiter, C.fail);
paymentRoutes.post("/cancel", callbackLimiter, C.cancel);
paymentRoutes.post("/ipn", callbackLimiter, C.ipn);
// SSLCommerz sandbox sometimes redirects with GET.
paymentRoutes.get("/success", callbackLimiter, C.success);
paymentRoutes.get("/fail", callbackLimiter, C.fail);
paymentRoutes.get("/cancel", callbackLimiter, C.cancel);

paymentRoutes.use(auth);

paymentRoutes.post(
	"/initiate",
	authorize("CITIZEN"),
	paymentLimiter,
	validateRequest(V.initiatePaymentSchema),
	idempotency("POST /payments/initiate"),
	C.initiate,
);
paymentRoutes.get("/my", authorize("CITIZEN"), validateRequest(V.listPaymentsSchema), C.listMine);

/*
  The staff ledger. Declared above `/:id` because `/:id` would otherwise match
  `/admin` as an id and its UUID validator would answer 400 rather than fall
  through — Express takes the first route that matches, not the first that
  validates.

  `authorize("ADMIN")` on top of the permission on purpose. Money is the one
  place where being granted a permission should not be enough on its own to
  widen the role that holds it.
*/
const ledger = [authorize("ADMIN"), requirePermission(PERMISSIONS.payments__view_all)] as const;

paymentRoutes.get("/admin/summary", ...ledger, validateRequest(V.ledgerSummarySchema), C.summary);
paymentRoutes.get("/admin/ledger.csv", ...ledger, validateRequest(V.ledgerCsvSchema), C.ledgerCsv);
paymentRoutes.get("/admin", ...ledger, validateRequest(V.ledgerSchema), C.listAll);

paymentRoutes.get("/:id", validateRequest(V.paymentIdSchema), C.getById);
paymentRoutes.get("/:id/receipt", validateRequest(V.paymentIdSchema), C.receipt);
paymentRoutes.post(
	"/:id/refund",
	authorize("ADMIN"),
	requirePermission(PERMISSIONS.payments__refund_request),
	validateRequest(V.refundRequestSchema),
	C.requestRefund,
);
paymentRoutes.patch(
	"/:id/refund/approve",
	authorize("ADMIN"),
	superAdminOnly,
	requirePermission(PERMISSIONS.payments__refund_approve),
	validateRequest(V.paymentIdSchema),
	C.approveRefund,
);
