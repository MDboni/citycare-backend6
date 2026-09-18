import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/app.js";
import { redis } from "@/config/redis.js";
import * as mailer from "@/lib/mailer.js";
import { prisma } from "@/lib/prisma.js";
import { closeConnections, hasTestDb, migrateTestDb, resetDb } from "./helpers.js";

const suite = hasTestDb ? describe : describe.skip;

const api = () => request(app);
const BASE = "/api/v1";

/** The mocked mailer is the only place the OTP can be read from. */
const lastOtp = (fn: { mock: { calls: unknown[][] } }): string => {
	const call = fn.mock.calls.at(-1);
	return String(call?.[1] ?? "");
};

suite("auth", () => {
	beforeAll(() => {
		migrateTestDb();
	});

	beforeEach(async () => {
		await resetDb();
		vi.clearAllMocks();
	});

	afterAll(async () => {
		await closeConnections();
	});

	describe("signup", () => {
		const body = {
			name: "Test Citizen",
			email: "newcitizen@citycare.com",
			password: "Str0ng!Passw0rd",
		};

		it("writes nothing to Postgres before the email is proven", async () => {
			const res = await api().post(`${BASE}/auth/register`).send(body).expect(202);

			expect(res.body.success).toBe(true);
			expect(await redis.exists("reg:pending:newcitizen@citycare.com")).toBe(1);
			expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
		});

		it("creates the user and an audit row once the OTP is verified", async () => {
			await api().post(`${BASE}/auth/register`).send(body).expect(202);
			const otp = lastOtp(vi.mocked(mailer.sendOtpEmail));

			const res = await api()
				.post(`${BASE}/auth/verify-otp`)
				.send({ email: body.email, otp })
				.expect(201);

			expect(res.body.data.accessToken).toBeTruthy();
			expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);
			expect(await prisma.auditLog.count({ where: { action: "USER_REGISTERED" } })).toBe(1);
		});

		it("drops the pending signup after five wrong codes", async () => {
			await api().post(`${BASE}/auth/register`).send(body).expect(202);

			for (let i = 0; i < 5; i += 1) {
				await api()
					.post(`${BASE}/auth/verify-otp`)
					.send({ email: body.email, otp: "000000" })
					.expect(400);
			}

			const res = await api()
				.post(`${BASE}/auth/verify-otp`)
				.send({ email: body.email, otp: "000000" })
				.expect(429);

			expect(res.body.errors[0].code).toBe("RATE_LIMITED");
			expect(await redis.exists("reg:pending:newcitizen@citycare.com")).toBe(0);
		});

		it("rejects an unknown key such as role — mass assignment stops here", async () => {
			const res = await api()
				.post(`${BASE}/auth/register`)
				.send({ ...body, role: "ADMIN" })
				.expect(400);

			expect(res.body.errors[0].code).toBe("VALIDATION_ERROR");
		});

		it("rejects a password that contains the email local part", async () => {
			await api()
				.post(`${BASE}/auth/register`)
				.send({ ...body, password: "Newcitizen@1234" })
				.expect(400);
		});
	});

	describe("login", () => {
		const password = "Str0ng!Passw0rd";

		const seedCitizen = async (twoFactorEnabled: boolean) => {
			const bcrypt = await import("bcryptjs");
			return prisma.user.create({
				data: {
					name: "Login User",
					email: "login@citycare.com",
					password: await bcrypt.default.hash(password, 10),
					role: "CITIZEN",
					twoFactorEnabled,
					emailVerifiedAt: new Date(),
				},
			});
		};

		it("returns tokens directly when 2FA is off", async () => {
			await seedCitizen(false);
			const res = await api()
				.post(`${BASE}/auth/login`)
				.send({ email: "login@citycare.com", password })
				.expect(200);

			expect(res.body.data.twoFactorRequired).toBe(false);
			expect(res.body.data.accessToken).toBeTruthy();
		});

		it("issues a masked challenge when 2FA is on, then accepts the code", async () => {
			await seedCitizen(true);

			const challenge = await api()
				.post(`${BASE}/auth/login`)
				.send({ email: "login@citycare.com", password })
				.expect(202);

			expect(challenge.body.data.twoFactorRequired).toBe(true);
			expect(challenge.body.data.email).not.toContain("login@");

			const otp = lastOtp(vi.mocked(mailer.sendLoginOtpEmail));

			await api()
				.post(`${BASE}/auth/login/verify-otp`)
				.send({ challengeId: challenge.body.data.challengeId, otp: "000000" })
				.expect(400);

			const ok = await api()
				.post(`${BASE}/auth/login/verify-otp`)
				.send({ challengeId: challenge.body.data.challengeId, otp })
				.expect(200);

			expect(ok.body.data.accessToken).toBeTruthy();
			expect(await prisma.securityEvent.count({ where: { type: "LOGIN_SUCCESS" } })).toBe(1);
		});

		it("refuses to reuse the same login OTP", async () => {
			await seedCitizen(true);
			const challenge = await api()
				.post(`${BASE}/auth/login`)
				.send({ email: "login@citycare.com", password })
				.expect(202);
			const otp = lastOtp(vi.mocked(mailer.sendLoginOtpEmail));
			const { challengeId } = challenge.body.data;

			await api().post(`${BASE}/auth/login/verify-otp`).send({ challengeId, otp }).expect(200);
			await api().post(`${BASE}/auth/login/verify-otp`).send({ challengeId, otp }).expect(400);
		});

		it("gives the same generic answer for an unknown email", async () => {
			const res = await api()
				.post(`${BASE}/auth/login`)
				.send({ email: "nobody@citycare.com", password })
				.expect(401);

			expect(res.body.message).toBe("Invalid credentials");
		});
	});

	describe("tokens", () => {
		const password = "Str0ng!Passw0rd";

		const loggedIn = async () => {
			const bcrypt = await import("bcryptjs");
			await prisma.user.create({
				data: {
					name: "Token User",
					email: "token@citycare.com",
					password: await bcrypt.default.hash(password, 10),
					role: "CITIZEN",
					twoFactorEnabled: false,
					emailVerifiedAt: new Date(),
				},
			});
			const res = await api()
				.post(`${BASE}/auth/login`)
				.send({ email: "token@citycare.com", password })
				.expect(200);
			return res.body.data as { accessToken: string; refreshToken: string };
		};

		it("kills the access token the moment you log out", async () => {
			const { accessToken } = await loggedIn();

			await api().get(`${BASE}/users/me`).set("Authorization", `Bearer ${accessToken}`).expect(200);
			await api()
				.post(`${BASE}/auth/logout`)
				.set("Authorization", `Bearer ${accessToken}`)
				.expect(200);

			const res = await api()
				.get(`${BASE}/users/me`)
				.set("Authorization", `Bearer ${accessToken}`)
				.expect(401);

			expect(res.body.errors[0].code).toBe("TOKEN_REVOKED");
		});

		it("rotates the refresh token and revokes every session on reuse", async () => {
			const { refreshToken } = await loggedIn();

			await api().post(`${BASE}/auth/refresh-token`).send({ refreshToken }).expect(200);

			const reuse = await api()
				.post(`${BASE}/auth/refresh-token`)
				.send({ refreshToken })
				.expect(401);

			expect(reuse.body.errors[0].code).toBe("TOKEN_REVOKED");
			expect(await prisma.securityEvent.count({ where: { type: "TOKEN_REUSE" } })).toBe(1);
			expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(0);
		});
	});
});
