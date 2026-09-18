import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { authorize } from "@/middlewares/authorize.js";
import { idempotency } from "@/middlewares/idempotency.js";
import { uploadImage, verifyImage } from "@/middlewares/upload.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as C from "@/modules/complaint/complaint.controller.js";
import * as V from "@/modules/complaint/complaint.validation.js";

export const complaintRoutes: Router = Router();

// --- public ----------------------------------------------------------------
// Limited fields only: status, category, ward, timeline. No personal data.
complaintRoutes.get("/track/:trackingId", validateRequest(V.trackingIdSchema), C.track);

complaintRoutes.use(auth);

// --- collection ------------------------------------------------------------
complaintRoutes.post(
	"/",
	authorize("CITIZEN"),
	validateRequest(V.createComplaintSchema),
	idempotency("POST /complaints"),
	C.create,
);
complaintRoutes.get(
	"/",
	authorize("ADMIN", "OFFICER"),
	validateRequest(V.listComplaintsSchema),
	C.list,
);
complaintRoutes.get(
	"/my",
	authorize("CITIZEN"),
	validateRequest(V.listComplaintsSchema),
	C.listMine,
);
complaintRoutes.get(
	"/my-assigned",
	authorize("OFFICER"),
	validateRequest(V.listComplaintsSchema),
	C.listAssigned,
);
complaintRoutes.get("/search", validateRequest(V.searchSchema), C.search);
complaintRoutes.get("/nearby", validateRequest(V.nearbySchema), C.nearby);

// --- single complaint ------------------------------------------------------
complaintRoutes.get("/:id", validateRequest(V.complaintIdSchema), C.getById);
complaintRoutes.patch(
	"/:id",
	authorize("CITIZEN"),
	validateRequest(V.updateComplaintSchema),
	C.update,
);
complaintRoutes.delete("/:id", authorize("ADMIN"), validateRequest(V.complaintIdSchema), C.remove);

// --- lifecycle -------------------------------------------------------------
// The transition map decides which role may make which move.
complaintRoutes.patch("/:id/status", validateRequest(V.changeStatusSchema), C.changeStatus);
complaintRoutes.post("/:id/assign", authorize("ADMIN"), validateRequest(V.assignSchema), C.assign);
complaintRoutes.post("/:id/cancel", authorize("CITIZEN"), validateRequest(V.noteSchema), C.cancel);
complaintRoutes.post("/:id/reopen", authorize("CITIZEN"), validateRequest(V.noteSchema), C.reopen);
complaintRoutes.get("/:id/history", validateRequest(V.complaintIdSchema), C.history);

// --- attachments, comments, reactions --------------------------------------
complaintRoutes.post(
	"/:id/attachments",
	uploadImage.single("file"),
	verifyImage,
	validateRequest(V.attachmentSchema),
	C.addAttachment,
);
complaintRoutes.post("/:id/comments", validateRequest(V.commentSchema), C.addComment);
complaintRoutes.get("/:id/comments", validateRequest(V.complaintIdSchema), C.listComments);
complaintRoutes.post(
	"/:id/upvote",
	authorize("CITIZEN"),
	validateRequest(V.complaintIdSchema),
	C.upvote,
);
complaintRoutes.post(
	"/:id/feedback",
	authorize("CITIZEN"),
	validateRequest(V.feedbackSchema),
	C.feedback,
);
