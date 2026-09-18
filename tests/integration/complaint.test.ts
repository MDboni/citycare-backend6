import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "@/app.js";
import { prisma } from "@/lib/prisma.js";
import { signAccessToken } from "@/utils/jwt.js";
import { closeConnections, hasTestDb, migrateTestDb, resetDb } from "./helpers.js";

const suite = hasTestDb ? describe : describe.skip;
const api = () => request(app);
const BASE = "/api/v1";

type Fixtures = Awaited<ReturnType<typeof seed>>;

/** A session row plus a matching token, so the auth middleware is satisfied. */
const tokenFor = async (user: { id: string; role: "CITIZEN" | "OFFICER" | "ADMIN" }) => {
	const session = await prisma.session.create({
		data: {
			userId: user.id,
			ip: "127.0.0.1",
			userAgent: "vitest",
			expiresAt: new Date(Date.now() + 3600_000),
		},
	});
	return signAccessToken({ sub: user.id, role: user.role, sid: session.id }).token;
};

const seed = async () => {
	const hash = await bcrypt.hash("Str0ng!Passw0rd", 10);
	const zone = await prisma.zone.create({ data: { name: "Test Zone" } });
	const ward = await prisma.ward.create({ data: { number: 1, name: "Mirpur", zoneId: zone.id } });
	const department = await prisma.department.create({
		data: { name: "Roads", email: "roads@citycare.test" },
	});
	const category = await prisma.category.create({
		data: { name: "Pothole", departmentId: department.id, slaHours: 72, defaultPriority: "HIGH" },
	});

	const make = (name: string, email: string, role: "CITIZEN" | "OFFICER" | "ADMIN", extra = {}) =>
		prisma.user.create({
			data: {
				name,
				email,
				password: hash,
				role,
				twoFactorEnabled: false,
				emailVerifiedAt: new Date(),
				...extra,
			},
		});

	const citizenA = await make("Citizen A", "a@citycare.test", "CITIZEN");
	const citizenB = await make("Citizen B", "b@citycare.test", "CITIZEN");
	const officer = await make("Officer", "o@citycare.test", "OFFICER", {
		departmentId: department.id,
	});
	const admin = await make("Admin", "admin@citycare.test", "ADMIN", { isSuperAdmin: true });

	return {
		ward,
		category,
		department,
		citizenA,
		citizenB,
		officer,
		admin,
		tokens: {
			citizenA: await tokenFor(citizenA),
			citizenB: await tokenFor(citizenB),
			officer: await tokenFor(officer),
			admin: await tokenFor(admin),
		},
	};
};

const createComplaint = (f: Fixtures, overrides: Record<string, unknown> = {}) =>
	api()
		.post(`${BASE}/complaints`)
		.set("Authorization", `Bearer ${f.tokens.citizenA}`)
		.send({
			title: "Road e boro gorto",
			description: "Mirpur 10 golchottor er pashe 3 foot gorto",
			categoryId: f.category.id,
			wardId: f.ward.id,
			address: "Mirpur 10, Dhaka",
			...overrides,
		});

suite("complaints", () => {
	let f: Fixtures;

	beforeAll(() => {
		migrateTestDb();
	});

	beforeEach(async () => {
		await resetDb();
		f = await seed();
	});

	afterAll(async () => {
		await closeConnections();
	});

	it("issues a tracking id, an SLA due date and a first history row", async () => {
		const res = await createComplaint(f).expect(201);

		expect(res.body.data.trackingId).toMatch(/^CC-\d{4}-\d{6}$/);
		expect(res.body.data.slaDueAt).toBeTruthy();
		expect(
			await prisma.complaintStatusHistory.count({ where: { complaintId: res.body.data.id } }),
		).toBe(1);
	});

	it("blocks the same complaint twice within 24 hours", async () => {
		await createComplaint(f).expect(201);
		const res = await createComplaint(f, { title: "Same pothole again here" }).expect(409);
		expect(res.body.errors[0].code).toBe("DUPLICATE_COMPLAINT");
	});

	it("keeps one citizen out of another citizen's complaint", async () => {
		const created = await createComplaint(f).expect(201);

		const res = await api()
			.patch(`${BASE}/complaints/${created.body.data.id}`)
			.set("Authorization", `Bearer ${f.tokens.citizenB}`)
			.send({ title: "Hijacked title here" })
			.expect(403);

		expect(res.body.errors[0].code).toBe("NOT_OWNER");
	});

	it("refuses a transition the state machine does not have", async () => {
		const created = await createComplaint(f).expect(201);

		const res = await api()
			.patch(`${BASE}/complaints/${created.body.data.id}/status`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.send({ status: "RESOLVED" })
			.expect(409);

		expect(res.body.errors[0].code).toBe("INVALID_TRANSITION");
	});

	it("lets exactly one of two concurrent status changes win", async () => {
		const created = await createComplaint(f).expect(201);
		const patch = () =>
			api()
				.patch(`${BASE}/complaints/${created.body.data.id}/status`)
				.set("Authorization", `Bearer ${f.tokens.admin}`)
				.send({ status: "UNDER_REVIEW" });

		const [a, b] = await Promise.all([patch(), patch()]);
		const codes = [a.status, b.status].sort();

		expect(codes).toEqual([200, 409]);
	});

	it("will not resolve without proof, and resolves once proof exists", async () => {
		const created = await createComplaint(f).expect(201);
		const id = created.body.data.id;

		await api()
			.patch(`${BASE}/complaints/${id}/status`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.send({ status: "UNDER_REVIEW" })
			.expect(200);
		await api()
			.post(`${BASE}/complaints/${id}/assign`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.send({ officerId: f.officer.id })
			.expect(200);
		await api()
			.patch(`${BASE}/complaints/${id}/status`)
			.set("Authorization", `Bearer ${f.tokens.officer}`)
			.send({ status: "IN_PROGRESS" })
			.expect(200);

		const refused = await api()
			.patch(`${BASE}/complaints/${id}/status`)
			.set("Authorization", `Bearer ${f.tokens.officer}`)
			.send({ status: "RESOLVED" })
			.expect(409);
		expect(refused.body.errors[0].message).toContain("RESOLUTION_PROOF");

		await prisma.attachment.create({
			data: {
				complaintId: id,
				url: "https://example.test/proof.jpg",
				publicId: "proof",
				kind: "RESOLUTION_PROOF",
				uploadedById: f.officer.id,
			},
		});

		await api()
			.patch(`${BASE}/complaints/${id}/status`)
			.set("Authorization", `Bearer ${f.tokens.officer}`)
			.send({ status: "RESOLVED" })
			.expect(200);
	});

	it("hides a soft-deleted complaint from reads and lists", async () => {
		const created = await createComplaint(f).expect(201);
		const id = created.body.data.id;

		await api()
			.delete(`${BASE}/complaints/${id}`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.expect(200);

		await api()
			.get(`${BASE}/complaints/${id}`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.expect(404);

		const list = await api()
			.get(`${BASE}/complaints`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.expect(200);
		expect(list.body.data).toHaveLength(0);
	});

	it("caps the page size and rejects an unknown sort field", async () => {
		await createComplaint(f).expect(201);

		const capped = await api()
			.get(`${BASE}/complaints?limit=1000`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.expect(200);
		expect(capped.body.meta.limit).toBe(100);

		await api()
			.get(`${BASE}/complaints?sortBy=hack`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.expect(400);
	});

	it("keeps a citizen token off the admin routes", async () => {
		const res = await api()
			.get(`${BASE}/admin/users`)
			.set("Authorization", `Bearer ${f.tokens.citizenA}`)
			.expect(403);

		expect(res.body.errors[0].code).toBe("FORBIDDEN_ROLE");
	});

	it("refuses to remove the last super admin", async () => {
		const second = await prisma.user.create({
			data: {
				name: "Second Admin",
				email: "admin2@citycare.test",
				password: await bcrypt.hash("Str0ng!Passw0rd", 10),
				role: "ADMIN",
				emailVerifiedAt: new Date(),
			},
		});
		const token = await tokenFor({ id: second.id, role: "ADMIN" });

		// The only super admin blocking themselves is refused by the self-check…
		await api()
			.patch(`${BASE}/admin/users/${f.admin.id}/status`)
			.set("Authorization", `Bearer ${f.tokens.admin}`)
			.send({ status: "BLOCKED" })
			.expect(403);

		// …and a plain admin cannot touch another admin at all.
		const res = await api()
			.patch(`${BASE}/admin/users/${f.admin.id}/status`)
			.set("Authorization", `Bearer ${token}`)
			.send({ status: "BLOCKED" })
			.expect(403);
		expect(res.body.errors[0].code).toBe("SUPER_ADMIN_ONLY");
	});

	it("returns the standard envelope for an unknown route", async () => {
		const res = await api().get(`${BASE}/nothing`).expect(404);

		expect(res.body).toMatchObject({ success: false });
		expect(res.body.errors[0].code).toBe("ROUTE_NOT_FOUND");
	});

	it("shows only public fields on the tracking endpoint", async () => {
		const created = await createComplaint(f).expect(201);

		const res = await api()
			.get(`${BASE}/complaints/track/${created.body.data.trackingId}`)
			.expect(200);

		expect(res.body.data).toHaveProperty("status");
		expect(res.body.data).not.toHaveProperty("citizen");
		expect(res.body.data).not.toHaveProperty("address");
	});
});
