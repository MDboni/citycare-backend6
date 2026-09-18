import { z } from "zod";

const email = z
	.string()
	.trim()
	.toLowerCase()
	.min(5)
	.max(254)
	.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Invalid email");

/**
 * Password policy: at least 10 characters with an upper case letter, a lower
 * case letter, a digit and a symbol. The "must not contain your name or email"
 * half is cross-field, so it is checked in `superRefine` below.
 */
const password = z
	.string()
	.min(10, "Password must be at least 10 characters")
	.max(128)
	.regex(/[a-z]/, "Password needs a lowercase letter")
	.regex(/[A-Z]/, "Password needs an uppercase letter")
	.regex(/[0-9]/, "Password needs a number")
	.regex(/[^A-Za-z0-9]/, "Password needs a symbol");

const otp = z
	.string()
	.trim()
	.regex(/^\d{6}$/, "OTP must be 6 digits");

const containsIdentity = (pwd: string, name: string | undefined, mail: string) => {
	const lower = pwd.toLowerCase();
	const local = mail.split("@")[0]?.toLowerCase() ?? "";
	if (local.length >= 3 && lower.includes(local)) return true;
	if (!name) return false;
	return name
		.toLowerCase()
		.split(/\s+/)
		.some((part) => part.length >= 3 && lower.includes(part));
};

/**
 * Every body schema is `.strict()`: an unknown key is a 400, which is what
 * stops `{"role": "ADMIN"}` from ever reaching a service.
 */
export const registerSchema = z.object({
	body: z
		.object({
			name: z.string().trim().min(2).max(80),
			email,
			password,
			phone: z.string().trim().max(20).optional(),
		})
		.strict()
		.superRefine((val, ctx) => {
			if (containsIdentity(val.password, val.name, val.email)) {
				ctx.addIssue({
					code: "custom",
					path: ["password"],
					message: "Password must not contain your name or email",
				});
			}
		}),
});

export const verifyOtpSchema = z.object({
	body: z.object({ email, otp }).strict(),
});

export const resendOtpSchema = z.object({
	body: z.object({ email }).strict(),
});

export const loginSchema = z.object({
	body: z
		.object({
			email,
			password: z.string().min(1, "Password is required").max(128),
			deviceToken: z.string().max(256).optional(),
		})
		.strict(),
});

export const verifyLoginOtpSchema = z.object({
	body: z
		.object({
			challengeId: z.string().trim().length(64),
			otp,
			trustDevice: z.boolean().optional().default(false),
		})
		.strict(),
});

export const resendLoginOtpSchema = z.object({
	body: z.object({ challengeId: z.string().trim().length(64) }).strict(),
});

export const refreshSchema = z.object({
	body: z.object({ refreshToken: z.string().min(20).optional() }).strict(),
});

export const sessionIdSchema = z.object({
	params: z.object({ id: z.string().uuid() }),
});

export const toggle2faSchema = z.object({
	body: z
		.object({
			enabled: z.boolean(),
			password: z.string().min(1).max(128),
			challengeId: z.string().trim().length(64).optional(),
			otp: otp.optional(),
		})
		.strict(),
});

export const forgotPasswordSchema = z.object({
	body: z.object({ email }).strict(),
});

export const resetPasswordSchema = z.object({
	body: z.object({ token: z.string().trim().min(20).max(256), password }).strict(),
});

export const changePasswordSchema = z.object({
	body: z
		.object({
			currentPassword: z.string().min(1).max(128),
			newPassword: password,
		})
		.strict()
		.refine((v) => v.currentPassword !== v.newPassword, {
			path: ["newPassword"],
			message: "New password must be different from the current one",
		}),
});

export const googleTokenSchema = z.object({
	body: z.object({ idToken: z.string().min(20) }).strict(),
});

export type RegisterInput = z.infer<typeof registerSchema>["body"];
export type LoginInput = z.infer<typeof loginSchema>["body"];
export type VerifyLoginOtpInput = z.infer<typeof verifyLoginOtpSchema>["body"];
export type Toggle2faInput = z.infer<typeof toggle2faSchema>["body"];
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>["body"];
