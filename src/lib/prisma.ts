import { PrismaPg } from "@prisma/adapter-pg";
import { env, isProd } from "@/config/env.js";
import { PrismaClient } from "@/generated/prisma/client.js";
import { logger } from "@/lib/logger.js";

/**
 * Models that carry `deletedAt`. Reads on these models automatically exclude
 * soft-deleted rows unless the caller explicitly passes `deletedAt` in `where`
 * (that is how admin restore and the purge job reach deleted rows).
 */
const softDeleteModels = new Set([
	"complaint",
	"user",
	"comment",
	"department",
	"category",
	"serviceType",
	"serviceRequest",
]);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

const base = new PrismaClient({
	adapter,
	log: [
		{ level: "query", emit: "event" },
		{ level: "warn", emit: "event" },
		{ level: "error", emit: "event" },
	],
});

base.$on("query", (e) => {
	if (e.duration > 500) logger.warn({ duration: e.duration, query: e.query }, "slow query");
});
base.$on("warn", (e) => logger.warn({ prisma: e.message }));
base.$on("error", (e) => logger.error({ prisma: e.message }));

/**
 * Soft-delete read filter. `findUnique` is deliberately NOT patched — its
 * `where` only accepts unique fields — so services that look a row up by id
 * must check `deletedAt` themselves (or use `findFirst`).
 */
type LooseArgs = { where?: Record<string, unknown> };

/**
 * Adds `deletedAt: null` to a read unless the caller asked for deleted rows
 * explicitly. The cast is unavoidable: `$allModels` widens `where` to a union
 * of every model's filter type.
 */
const applySoftDelete = (model: string, args: unknown): void => {
	if (!softDeleteModels.has(lowerFirst(model))) return;
	const a = args as LooseArgs;
	if (a.where?.deletedAt !== undefined) return;
	a.where = { ...a.where, deletedAt: null };
};

export const prisma = base.$extends({
	name: "softDelete",
	query: {
		$allModels: {
			async findMany({ model, args, query }) {
				applySoftDelete(model, args);
				return query(args);
			},
			async findFirst({ model, args, query }) {
				applySoftDelete(model, args);
				return query(args);
			},
			async count({ model, args, query }) {
				applySoftDelete(model, args);
				return query(args);
			},
		},
	},
});

export type ExtendedPrismaClient = typeof prisma;

export const connectDb = async (): Promise<void> => {
	await base.$queryRaw`SELECT 1`;
	logger.info("PostgreSQL connected");
};

export const disconnectDb = async (): Promise<void> => {
	await base.$disconnect();
};

/** `/ready` uses this: a failing ping must answer 503, not 200. */
export const pingDb = async (): Promise<boolean> => {
	try {
		await base.$queryRaw`SELECT 1`;
		return true;
	} catch (err) {
		if (!isProd) logger.error({ err }, "database ping failed");
		return false;
	}
};

/**
 * The client handed to `$transaction` callbacks. Plain `prisma` is assignable
 * to it too, so helpers like `audit()` and `notify()` work inside or outside
 * a transaction.
 */
export type TxClient = Omit<
	ExtendedPrismaClient,
	"$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;
