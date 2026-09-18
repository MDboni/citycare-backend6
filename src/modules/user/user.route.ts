import { Router } from "express";
import { auth } from "@/middlewares/auth.js";
import { uploadImage, verifyImage } from "@/middlewares/upload.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as UserController from "@/modules/user/user.controller.js";
import { updateMeSchema } from "@/modules/user/user.validation.js";

export const userRoutes: Router = Router();

userRoutes.use(auth);

userRoutes.get("/me", UserController.getMe);
userRoutes.patch("/me", validateRequest(updateMeSchema), UserController.updateMe);
userRoutes.patch(
	"/me/avatar",
	uploadImage.single("avatar"),
	verifyImage,
	UserController.updateAvatar,
);
userRoutes.get("/me/export", UserController.exportData);
userRoutes.delete("/me", UserController.deleteMe);
