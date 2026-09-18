import type { Request, Response } from "express";
import { env } from "@/config/env.js";
import { requireUser } from "@/middlewares/auth.js";
import { validatedParams } from "@/middlewares/validateRequest.js";
import * as AuthService from "@/modules/auth/auth.service.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { toCtx } from "@/utils/context.js";
import { sendResponse } from "@/utils/sendResponse.js";

/**
 * Controllers only translate: request in, one service call, one response out.
 * No Prisma, no business rules, no try/catch.
 */

export const register = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.startSignup(req.body);
	sendResponse(res, {
		statusCode: 202,
		message: "Verification code sent to your email",
		data,
	});
});

export const verifyOtp = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.verifyOtp(req.body.email, req.body.otp, toCtx(req));
	sendResponse(res, { statusCode: 201, message: "Account created successfully", data });
});

export const resendOtp = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.resendOtp(req.body.email);
	sendResponse(res, { statusCode: 202, message: "Verification code sent", data });
});

export const login = catchAsync(async (req: Request, res: Response) => {
	const result = await AuthService.login(req.body.email, req.body.password, {
		...toCtx(req),
		deviceToken: req.body.deviceToken ?? req.cookies?.deviceToken,
	});

	if (result.twoFactorRequired) {
		sendResponse(res, {
			statusCode: 202,
			message: "Two-factor verification required",
			data: result,
		});
		return;
	}

	sendResponse(res, { message: "Logged in successfully", data: result });
});

export const verifyLoginOtp = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.verifyLoginOtp(
		req.body.challengeId,
		req.body.otp,
		Boolean(req.body.trustDevice),
		toCtx(req),
	);
	sendResponse(res, { message: "Logged in successfully", data });
});

export const resendLoginOtp = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.resendLoginOtp(req.body.challengeId, toCtx(req));
	sendResponse(res, { statusCode: 202, message: "Verification code sent", data });
});

export const refreshToken = catchAsync(async (req: Request, res: Response) => {
	const token = req.body?.refreshToken ?? req.cookies?.refreshToken;
	if (!token) {
		throw new ApiError(401, "Refresh token is required", [
			{ code: "TOKEN_MISSING", message: "Refresh token is required" },
		]);
	}
	const data = await AuthService.refresh(token, toCtx(req));
	sendResponse(res, { message: "Token refreshed", data });
});

export const logout = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	if (!req.sessionId || !req.token) throw new ApiError(401, "Unauthorized");

	await AuthService.logout(user.id, req.sessionId, req.token);
	sendResponse(res, { message: "Logged out successfully" });
});

export const logoutAll = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	const data = await AuthService.logoutAll(user.id);
	sendResponse(res, { message: "All sessions revoked", data });
});

export const listSessions = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	const data = await AuthService.listSessions(user.id, req.sessionId);
	sendResponse(res, { message: "Sessions retrieved", data });
});

export const revokeSession = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	const { id } = validatedParams<{ id: string }>(req);
	await AuthService.revokeSession(user.id, id);
	sendResponse(res, { message: "Session revoked" });
});

export const toggle2fa = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	const result = await AuthService.toggle2fa(user.id, req.body, toCtx(req));

	sendResponse(res, {
		statusCode: result.otpRequired ? 202 : 200,
		message: result.otpRequired
			? "Verification code sent, confirm to apply the change"
			: "Two-factor setting updated",
		data: result,
	});
});

export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.forgotPassword(req.body.email);
	sendResponse(res, { message: data.message, data: null });
});

export const resetPassword = catchAsync(async (req: Request, res: Response) => {
	const data = await AuthService.resetPassword(req.body.token, req.body.password, toCtx(req));
	sendResponse(res, { message: data.message, data: null });
});

export const changePassword = catchAsync(async (req: Request, res: Response) => {
	const user = requireUser(req);
	const data = await AuthService.changePassword(user.id, req.body, toCtx(req));
	sendResponse(res, { message: data.message, data: null });
});

/**
 * Browser flow: Google redirects here, and we bounce the user back to the
 * client with either a challenge id or the tokens — never rendering HTML.
 */
export const googleCallback = catchAsync(async (req: Request, res: Response) => {
	const profile = req.user as unknown as Parameters<typeof AuthService.handleGoogleProfile>[0];
	const result = await AuthService.handleGoogleProfile(profile, toCtx(req));
	const client = env.CLIENT_URL.split(",")[0];

	const params = new URLSearchParams();
	if (result.newUser) {
		params.set("status", "verify-email");
		params.set("email", String(result.email));
	} else if (result.twoFactorRequired) {
		params.set("status", "otp-required");
		params.set("challengeId", String(result.challengeId));
	} else {
		params.set("status", "success");
		params.set("accessToken", String(result.accessToken));
		params.set("refreshToken", String(result.refreshToken));
	}

	res.redirect(`${client}/auth/callback?${params.toString()}`);
});

export const googleToken = catchAsync(async (req: Request, res: Response) => {
	const result = await AuthService.googleToken(req.body.idToken, toCtx(req));
	const pending = result.newUser || ("twoFactorRequired" in result && result.twoFactorRequired);

	sendResponse(res, {
		statusCode: pending ? 202 : 200,
		message: pending ? "Verification required" : "Logged in successfully",
		data: result,
	});
});
