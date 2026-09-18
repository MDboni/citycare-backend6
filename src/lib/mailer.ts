import nodemailer, { type Transporter } from "nodemailer";
import { env, isProd } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { prisma } from "@/lib/prisma.js";

export type EmailTemplate =
	| "OTP_SIGNUP"
	| "OTP_LOGIN"
	| "STATUS_UPDATE"
	| "RECEIPT"
	| "NEW_DEVICE"
	| "PASSWORD_RESET"
	| "OFFICER_INVITE"
	| "ESCALATION";

export const smtpConfigured = Boolean(env.SMTP_USER && env.SMTP_PASS);

const transporter: Transporter = nodemailer.createTransport({
	host: env.SMTP_HOST,
	port: env.SMTP_PORT,
	secure: env.SMTP_PORT === 465,
	auth: smtpConfigured ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});

export const verifyMailer = async (): Promise<boolean> => {
	if (!smtpConfigured) {
		logger.warn("SMTP is not configured — emails will be logged instead of sent");
		return false;
	}
	try {
		await transporter.verify();
		logger.info("SMTP connected");
		return true;
	} catch (err) {
		logger.warn({ err: (err as Error).message }, "SMTP verification failed");
		return false;
	}
};

const layout = (title: string, body: string): string => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Segoe UI,Arial,sans-serif;color:#1f2933">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <h1 style="margin:0 0 4px;font-size:20px;color:#0b6bcb">CityCare</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#6b7280">City Complaint &amp; Service Platform</p>
    <h2 style="font-size:17px;margin:0 0 12px">${title}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 12px">
    <p style="font-size:12px;color:#9ca3af;margin:0">
      This is an automated message — please do not reply.
    </p>
  </div>
</body></html>`;

const otpBlock = (otp: string, minutes: number) => `
  <p style="margin:0 0 16px">Use this verification code:</p>
  <p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:0 0 16px;color:#0b6bcb">${otp}</p>
  <p style="margin:0;color:#6b7280;font-size:14px">
    It expires in ${minutes} minutes. If you did not request it, ignore this email.
  </p>`;

/**
 * Every send is recorded in EmailLog — the template name only. An OTP or a
 * token must never be persisted in the log table.
 */
const send = async (
	to: string,
	template: EmailTemplate,
	subject: string,
	html: string,
): Promise<void> => {
	const log = await prisma.emailLog.create({ data: { to, template, status: "QUEUED" } });

	if (!smtpConfigured) {
		// Local development without a mailbox: the request still succeeds.
		if (!isProd) logger.info({ to, template, subject }, "email not sent (SMTP not configured)");
		await prisma.emailLog.update({
			where: { id: log.id },
			data: { status: "FAILED", error: "SMTP not configured", attempts: { increment: 1 } },
		});
		return;
	}

	try {
		await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, html });
		await prisma.emailLog.update({
			where: { id: log.id },
			data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 } },
		});
	} catch (err) {
		const message = (err as Error).message;
		logger.error({ template, err: message }, "email send failed");
		await prisma.emailLog.update({
			where: { id: log.id },
			data: { status: "FAILED", error: message.slice(0, 500), attempts: { increment: 1 } },
		});
	}
};

/**
 * In development without SMTP the OTP would otherwise be unreachable, so it is
 * printed to the server log. Never in production.
 */
const devOtpHint = (to: string, otp: string, kind: string): void => {
	if (isProd || smtpConfigured) return;
	logger.warn(`[dev only] ${kind} OTP for ${to}: ${otp}`);
};

export const sendOtpEmail = async (to: string, otp: string, minutes = 10): Promise<void> => {
	devOtpHint(to, otp, "signup");
	await send(
		to,
		"OTP_SIGNUP",
		"Verify your CityCare account",
		layout("Confirm your email", otpBlock(otp, minutes)),
	);
};

export const sendLoginOtpEmail = async (to: string, otp: string, minutes = 5): Promise<void> => {
	devOtpHint(to, otp, "login");
	await send(
		to,
		"OTP_LOGIN",
		"Your CityCare login code",
		layout("Two-factor verification", otpBlock(otp, minutes)),
	);
};

export const sendNewLoginAlert = async (
	to: string,
	ctx: { ip?: string; userAgent?: string },
): Promise<void> => {
	await send(
		to,
		"NEW_DEVICE",
		"New sign-in to your CityCare account",
		layout(
			"New device signed in",
			`<p style="margin:0 0 12px">A new device just signed in to your account.</p>
       <p style="margin:0 0 4px;font-size:14px"><b>IP:</b> ${ctx.ip ?? "unknown"}</p>
       <p style="margin:0 0 16px;font-size:14px"><b>Device:</b> ${ctx.userAgent ?? "unknown"}</p>
       <p style="margin:0;color:#b91c1c">If this was not you, change your password immediately.</p>`,
		),
	);
};

export const sendPasswordResetEmail = async (to: string, token: string): Promise<void> => {
	const link = `${env.CLIENT_URL.split(",")[0]}/reset-password?token=${token}`;
	if (!isProd && !smtpConfigured) logger.warn(`[dev only] password reset link: ${link}`);
	await send(
		to,
		"PASSWORD_RESET",
		"Reset your CityCare password",
		layout(
			"Password reset",
			`<p style="margin:0 0 16px">Click the button below to choose a new password. The link expires in 15 minutes.</p>
       <p style="margin:0 0 16px"><a href="${link}" style="background:#0b6bcb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">Reset password</a></p>
       <p style="margin:0;color:#6b7280;font-size:13px">If you did not request this, nothing has changed.</p>`,
		),
	);
};

export const sendStatusUpdateEmail = async (
	to: string,
	payload: { trackingId: string; status: string; note?: string | null },
): Promise<void> => {
	await send(
		to,
		"STATUS_UPDATE",
		`Complaint ${payload.trackingId} is now ${payload.status}`,
		layout(
			"Complaint update",
			`<p style="margin:0 0 12px">Your complaint <b>${payload.trackingId}</b> is now
         <b style="color:#0b6bcb">${payload.status}</b>.</p>
       ${payload.note ? `<p style="margin:0 0 12px;color:#4b5563">${payload.note}</p>` : ""}
       <p style="margin:0;font-size:13px;color:#6b7280">Track it any time with your tracking id.</p>`,
		),
	);
};

export const sendReceiptEmail = async (
	to: string,
	payload: { transactionId: string; amount: string; serviceName: string; receiptUrl?: string },
): Promise<void> => {
	await send(
		to,
		"RECEIPT",
		`Payment receipt — ${payload.transactionId}`,
		layout(
			"Payment received",
			`<p style="margin:0 0 12px">We received your payment for <b>${payload.serviceName}</b>.</p>
       <p style="margin:0 0 4px;font-size:14px"><b>Transaction:</b> ${payload.transactionId}</p>
       <p style="margin:0 0 16px;font-size:14px"><b>Amount:</b> BDT ${payload.amount}</p>
       ${payload.receiptUrl ? `<p style="margin:0"><a href="${payload.receiptUrl}">Download receipt (PDF)</a></p>` : ""}`,
		),
	);
};

export const sendOfficerInviteEmail = async (
	to: string,
	payload: { name: string; tempPassword: string },
): Promise<void> => {
	if (!isProd && !smtpConfigured)
		logger.warn(`[dev only] temp password for ${to}: ${payload.tempPassword}`);
	await send(
		to,
		"OFFICER_INVITE",
		"Your CityCare officer account",
		layout(
			"Welcome to CityCare",
			`<p style="margin:0 0 12px">Hello ${payload.name}, an officer account has been created for you.</p>
       <p style="margin:0 0 4px;font-size:14px"><b>Email:</b> ${to}</p>
       <p style="margin:0 0 16px;font-size:14px"><b>Temporary password:</b> ${payload.tempPassword}</p>
       <p style="margin:0;color:#b91c1c">Change this password right after your first login.</p>`,
		),
	);
};

export const sendEscalationEmail = async (
	to: string,
	payload: { trackingId: string; level: number; reason: string },
): Promise<void> => {
	await send(
		to,
		"ESCALATION",
		`SLA breach — ${payload.trackingId} (level ${payload.level})`,
		layout(
			"SLA breached",
			`<p style="margin:0 0 12px">Complaint <b>${payload.trackingId}</b> has breached its SLA.</p>
       <p style="margin:0 0 4px;font-size:14px"><b>Escalation level:</b> ${payload.level}</p>
       <p style="margin:0;font-size:14px"><b>Reason:</b> ${payload.reason}</p>`,
		),
	);
};

export { transporter };
