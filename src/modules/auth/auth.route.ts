import { Router } from "express";
import passport from "@/config/passport.js";
import { auth } from "@/middlewares/auth.js";
import { authorize } from "@/middlewares/authorize.js";
import { authLimiter } from "@/middlewares/rateLimiter.js";
import { validateRequest } from "@/middlewares/validateRequest.js";
import * as AuthController from "@/modules/auth/auth.controller.js";
import * as V from "@/modules/auth/auth.validation.js";

export const authRoutes: Router = Router();

// --- signup ----------------------------------------------------------------
authRoutes.post(
	"/register",
	authLimiter,
	validateRequest(V.registerSchema),
	AuthController.register,
);
authRoutes.post("/verify-otp", validateRequest(V.verifyOtpSchema), AuthController.verifyOtp);
authRoutes.post(
	"/resend-otp",
	authLimiter,
	validateRequest(V.resendOtpSchema),
	AuthController.resendOtp,
);

// --- login -----------------------------------------------------------------
authRoutes.post("/login", authLimiter, validateRequest(V.loginSchema), AuthController.login);
authRoutes.post(
	"/login/verify-otp",
	validateRequest(V.verifyLoginOtpSchema),
	AuthController.verifyLoginOtp,
);
authRoutes.post(
	"/login/resend-otp",
	authLimiter,
	validateRequest(V.resendLoginOtpSchema),
	AuthController.resendLoginOtp,
);
// The link from the same email. GET, because a mail client will only ever
// follow one — which is also why it is rate limited and single use.
authRoutes.get(
	"/login/magic",
	authLimiter,
	validateRequest(V.magicLoginSchema),
	AuthController.magicLogin,
);

// --- tokens and sessions ---------------------------------------------------
authRoutes.post("/refresh-token", validateRequest(V.refreshSchema), AuthController.refreshToken);
authRoutes.post("/logout", auth, AuthController.logout);
authRoutes.post("/logout-all", auth, AuthController.logoutAll);
authRoutes.get("/sessions", auth, AuthController.listSessions);
authRoutes.delete(
	"/sessions/:id",
	auth,
	validateRequest(V.sessionIdSchema),
	AuthController.revokeSession,
);

// --- two factor ------------------------------------------------------------
authRoutes.patch(
	"/2fa",
	auth,
	authorize("CITIZEN"),
	validateRequest(V.toggle2faSchema),
	AuthController.toggle2fa,
);

// --- passwords -------------------------------------------------------------
authRoutes.post(
	"/forgot-password",
	authLimiter,
	validateRequest(V.forgotPasswordSchema),
	AuthController.forgotPassword,
);
authRoutes.post(
	"/reset-password",
	authLimiter,
	validateRequest(V.resetPasswordSchema),
	AuthController.resetPassword,
);
authRoutes.patch(
	"/change-password",
	auth,
	validateRequest(V.changePasswordSchema),
	AuthController.changePassword,
);

// --- google ----------------------------------------------------------------
// `session: false` — passport only parses the profile; our own session table
// is the source of truth.
authRoutes.get(
	"/google",
	passport.authenticate("google", { scope: ["profile", "email"], session: false }),
);
authRoutes.get(
	"/google/callback",
	passport.authenticate("google", { session: false, failureRedirect: "/api/v1/auth/google" }),
	AuthController.googleCallback,
);
authRoutes.post(
	"/google/token",
	authLimiter,
	validateRequest(V.googleTokenSchema),
	AuthController.googleToken,
);
