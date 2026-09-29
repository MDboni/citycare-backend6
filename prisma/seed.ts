import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { PERMISSION_CATALOGUE, SYSTEM_ROLES } from "../src/config/permissions.js";
import { redis } from "../src/config/redis.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import type { ComplaintStatus, Priority } from "../src/generated/prisma/enums.js";
import { invalidateMasterData } from "../src/lib/cache.js";

/**
 * Idempotent seed: every write is an `upsert` keyed on something stable, so
 * running it twice changes nothing. Safe against a production database.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to seed");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL ?? "admin@citycare.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin@12345";

const hash = (plain: string) => bcrypt.hash(plain, SALT_ROUNDS);

/** Email uniqueness is a partial index, so upsert-by-email needs a lookup. */
const upsertUser = async (
	email: string,
	data: Parameters<typeof prisma.user.create>[0]["data"],
) => {
	const existing = await prisma.user.findFirst({ where: { email, deletedAt: null } });
	if (existing) {
		return prisma.user.update({
			where: { id: existing.id },
			data: { ...data, email, password: existing.password ?? data.password },
		});
	}
	return prisma.user.create({ data: { ...data, email } });
};

const main = async () => {
	console.log("Seeding CityCare…");

	// --- settings ----------------------------------------------------------
	const settings: Record<string, number> = {
		REOPEN_LIMIT: 2,
		REOPEN_WINDOW_DAYS: 7,
		URGENT_SLA_FACTOR: 0.5,
		LOGIN_OTP_TTL_SEC: 300,
		SIGNUP_OTP_TTL_SEC: 600,
	};
	for (const [key, value] of Object.entries(settings)) {
		await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: {} });
	}

	// --- zones and wards ---------------------------------------------------
	const zoneNames = ["North Zone", "South Zone"];
	const zones = [];
	for (const name of zoneNames) {
		zones.push(await prisma.zone.upsert({ where: { name }, create: { name }, update: {} }));
	}

	const wardNames = [
		"Mirpur",
		"Uttara",
		"Gulshan",
		"Banani",
		"Mohakhali",
		"Dhanmondi",
		"Motijheel",
		"Jatrabari",
		"Badda",
		"Tejgaon",
	];
	const wards = [];
	for (const [index, name] of wardNames.entries()) {
		const number = index + 1;
		wards.push(
			await prisma.ward.upsert({
				where: { number },
				create: { number, name, zoneId: zones[index % zones.length]?.id },
				update: { name },
			}),
		);
	}

	// --- departments -------------------------------------------------------
	const departmentSeed = [
		{
			name: "Roads",
			email: "roads@citycare.com",
			phone: "+880 2 5566 0101",
			address: "Roads Division, Nagar Bhaban, Dhaka 1000",
		},
		{
			name: "Waste",
			email: "waste@citycare.com",
			phone: "+880 2 5566 0102",
			address: "Waste Management Cell, Nagar Bhaban, Dhaka 1000",
		},
		{
			name: "Water",
			email: "water@citycare.com",
			phone: "+880 2 5566 0103",
			address: "Water & Drainage Division, Nagar Bhaban, Dhaka 1000",
		},
		{
			name: "Electricity",
			email: "electricity@citycare.com",
			phone: "+880 2 5566 0104",
			address: "Street Lighting Cell, Nagar Bhaban, Dhaka 1000",
		},
	];
	const departments = [];
	for (const d of departmentSeed) {
		const existingDepartment = await prisma.department.findUnique({
			where: { name: d.name },
			select: { phone: true, address: true },
		});
		departments.push(
			await prisma.department.upsert({
				where: { name: d.name },
				create: d,
				/**
				 * Fill the gaps, never overwrite. Seed values are a starting
				 * point, not a source of truth — an admin who corrects a desk
				 * number from the console keeps that correction the next time
				 * the seed runs, but a department created before these columns
				 * existed still picks up a default.
				 */
				update: {
					email: d.email,
					phone: existingDepartment?.phone ?? d.phone,
					address: existingDepartment?.address ?? d.address,
				},
			}),
		);
	}
	const departmentByName = new Map(departments.map((d) => [d.name, d]));

	// --- categories --------------------------------------------------------
	const categorySeed: {
		name: string;
		department: string;
		slaHours: number;
		defaultPriority: Priority;
	}[] = [
		{ name: "Pothole", department: "Roads", slaHours: 72, defaultPriority: "HIGH" },
		{ name: "Broken footpath", department: "Roads", slaHours: 120, defaultPriority: "MEDIUM" },
		{
			name: "Street light not working",
			department: "Electricity",
			slaHours: 48,
			defaultPriority: "HIGH",
		},
		{
			name: "Dangling power cable",
			department: "Electricity",
			slaHours: 12,
			defaultPriority: "URGENT",
		},
		{ name: "Garbage not collected", department: "Waste", slaHours: 24, defaultPriority: "MEDIUM" },
		{ name: "Illegal dumping", department: "Waste", slaHours: 72, defaultPriority: "MEDIUM" },
		{ name: "Waterlogging", department: "Water", slaHours: 24, defaultPriority: "URGENT" },
		{ name: "Water supply disruption", department: "Water", slaHours: 24, defaultPriority: "HIGH" },
		{ name: "Sewer overflow", department: "Water", slaHours: 24, defaultPriority: "URGENT" },
		{ name: "Damaged road divider", department: "Roads", slaHours: 168, defaultPriority: "LOW" },
	];

	const categories = [];
	for (const c of categorySeed) {
		const department = departmentByName.get(c.department);
		if (!department) continue;
		categories.push(
			await prisma.category.upsert({
				where: { name: c.name },
				create: {
					name: c.name,
					departmentId: department.id,
					slaHours: c.slaHours,
					defaultPriority: c.defaultPriority,
				},
				update: { slaHours: c.slaHours, defaultPriority: c.defaultPriority },
			}),
		);
	}

	// --- service types -----------------------------------------------------
	const serviceTypeSeed = [
		{ name: "Trade licence renewal", fee: "2500.00" },
		{ name: "Holding tax payment", fee: "1500.00" },
		{ name: "Birth certificate copy", fee: "50.00" },
		{ name: "Bulk waste pickup", fee: "800.00" },
		{ name: "Building plan approval", fee: "5000.00" },
	];
	for (const s of serviceTypeSeed) {
		await prisma.serviceType.upsert({
			where: { name: s.name },
			create: { name: s.name, fee: s.fee },
			update: { fee: s.fee },
		});
	}

	// --- super admin -------------------------------------------------------
	// The seed script is the ONLY place that may set isSuperAdmin.
	const superAdmin = await upsertUser(SUPER_ADMIN_EMAIL, {
		name: "CityCare Super Admin",
		email: SUPER_ADMIN_EMAIL,
		password: await hash(ADMIN_PASSWORD),
		role: "ADMIN",
		isSuperAdmin: true,
		twoFactorEnabled: false,
		emailVerifiedAt: new Date(),
	});

	// --- officers ----------------------------------------------------------
	const officerPassword = await hash("Officer@12345");
	const officers = [];
	for (const [index, department] of departments.slice(0, 3).entries()) {
		officers.push(
			await upsertUser(`officer${index + 1}@citycare.com`, {
				name: `${department.name} Officer`,
				email: `officer${index + 1}@citycare.com`,
				password: officerPassword,
				role: "OFFICER",
				departmentId: department.id,
				wardId: wards[index]?.id,
				twoFactorEnabled: false,
				emailVerifiedAt: new Date(),
			}),
		);
	}

	// --- citizens ----------------------------------------------------------
	const citizenPassword = await hash("Citizen@12345");
	const citizens = [];
	for (let i = 1; i <= 5; i += 1) {
		citizens.push(
			await upsertUser(`citizen${i}@citycare.com`, {
				name: `Citizen ${i}`,
				email: `citizen${i}@citycare.com`,
				password: citizenPassword,
				role: "CITIZEN",
				phone: `0171000000${i}`,
				wardId: wards[i % wards.length]?.id,
				// citizen1 has 2FA off so an evaluator can log in without a mailbox.
				twoFactorEnabled: i !== 1,
				emailVerifiedAt: new Date(),
			}),
		);
	}

	// --- complaints --------------------------------------------------------
	const year = new Date().getUTCFullYear();
	const statuses: ComplaintStatus[] = [
		"SUBMITTED",
		"UNDER_REVIEW",
		"ASSIGNED",
		"IN_PROGRESS",
		"RESOLVED",
		"CLOSED",
		"REOPENED",
		"REJECTED",
		"CANCELLED",
	];

	const existingCount = await prisma.complaint.count();
	if (existingCount === 0) {
		for (let i = 1; i <= 20; i += 1) {
			const category = categories[i % categories.length];
			const ward = wards[i % wards.length];
			const citizen = citizens[i % citizens.length];
			const status = statuses[i % statuses.length] ?? "SUBMITTED";
			if (!category || !ward || !citizen) continue;

			const needsOfficer = ["ASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(status);
			const officer = officers.find((o) => o.departmentId === category.departmentId);
			const createdAt = new Date(Date.now() - i * 36 * 3600_000);
			const resolved = ["RESOLVED", "CLOSED"].includes(status);

			const complaint = await prisma.complaint.create({
				data: {
					trackingId: `CC-${year}-${String(i).padStart(6, "0")}`,
					title: `${category.name} near ward ${ward.number}`,
					description: `Seeded complaint #${i}: ${category.name.toLowerCase()} reported by ${citizen.name}.`,
					address: `${ward.name}, Dhaka`,
					latitude: 23.78 + i * 0.002,
					longitude: 90.4 + i * 0.002,
					status,
					priority: category.defaultPriority,
					citizenId: citizen.id,
					officerId: needsOfficer ? (officer?.id ?? null) : null,
					categoryId: category.id,
					wardId: ward.id,
					slaDueAt: new Date(createdAt.getTime() + category.slaHours * 3600_000),
					createdAt,
					resolvedAt: resolved ? new Date(createdAt.getTime() + 20 * 3600_000) : null,
					closedAt: status === "CLOSED" ? new Date(createdAt.getTime() + 30 * 3600_000) : null,
					upvoteCount: i % 7,
				},
			});

			await prisma.complaintStatusHistory.create({
				data: {
					complaintId: complaint.id,
					toStatus: "SUBMITTED",
					changedById: citizen.id,
					createdAt,
				},
			});

			if (status !== "SUBMITTED") {
				await prisma.complaintStatusHistory.create({
					data: {
						complaintId: complaint.id,
						fromStatus: "SUBMITTED",
						toStatus: status,
						note: "Seeded transition",
						changedById: superAdmin.id,
						createdAt: new Date(createdAt.getTime() + 3600_000),
					},
				});
			}
		}

		await prisma.complaintCounter.upsert({
			where: { year },
			create: { year, value: 20 },
			update: { value: 20 },
		});
	}

	await prisma.complaintCounter.upsert({
		where: { year: -year },
		create: { year: -year, value: 0 },
		update: {},
	});

	// --- access control ----------------------------------------------------
	// The catalogue is the source of truth: every code in it exists in the
	// database after this runs, and a code that has been renamed leaves its old
	// row behind rather than being deleted, because a role may still point at it.
	for (const def of PERMISSION_CATALOGUE) {
		await prisma.permission.upsert({
			where: { code: def.code },
			create: {
				code: def.code,
				name: def.name,
				description: def.description,
				category: def.category,
				isSystem: true,
			},
			// Names and blurbs are ours to correct; isSystem is re-asserted so a
			// seeded permission cannot be left deletable by an earlier run.
			update: {
				name: def.name,
				description: def.description,
				category: def.category,
				isSystem: true,
			},
		});
	}

	const permissionByCode = new Map(
		(await prisma.permission.findMany({ select: { id: true, code: true } })).map((p) => [
			p.code,
			p.id,
		]),
	);

	for (const sys of SYSTEM_ROLES) {
		const role = await prisma.accessRole.upsert({
			where: { mirrors: sys.role },
			create: {
				name: sys.name,
				description: sys.description,
				isSystem: true,
				mirrors: sys.role,
			},
			update: { description: sys.description, isSystem: true },
		});

		const wanted = PERMISSION_CATALOGUE.filter((p) =>
			(p.defaultRoles as readonly string[]).includes(sys.role),
		)
			.map((p) => permissionByCode.get(p.code))
			.filter((id): id is string => Boolean(id));

		// createMany + skipDuplicates rather than a delete-then-insert: an admin
		// may have already tuned this role, and a re-seed must not silently undo
		// their work. Seeding only ever ADDS the defaults back.
		await prisma.accessRolePermission.createMany({
			data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
			skipDuplicates: true,
		});
	}

	/**
	 * The taxonomy endpoints cache for an hour, and seeding writes underneath
	 * them with Prisma directly — so without this a reseed is invisible to the
	 * API until the TTL runs out. Found the hard way: new department columns
	 * were in the database and absent from /departments for an hour.
	 */
	await invalidateMasterData();

	console.log(`
Seed complete.

  Super admin  ${SUPER_ADMIN_EMAIL} / ${ADMIN_PASSWORD}   (2FA off)
  Officers     officer1@citycare.com … officer3@citycare.com / Officer@12345   (2FA off)
  Citizens     citizen1@citycare.com … citizen5@citycare.com / Citizen@12345
               citizen1 has 2FA off; citizen2-5 need an email OTP

  Access       ${PERMISSION_CATALOGUE.length} permissions, ${SYSTEM_ROLES.length} system roles
               Staff with no explicit role fall back to the one mirroring their account type
`);
};

main()
	.catch((err) => {
		console.error("Seed failed:", err);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
		// ioredis holds the event loop open, so the seed has to hang up too.
		await redis.quit().catch(() => redis.disconnect());
	});
