import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
	type Application,
	type Request,
	type RequestHandler,
	type Response,
} from "express";
import helmet from "helmet";
import hpp from "hpp";
import { pinoHttp } from "pino-http";
import { corsOrigins, env } from "@/config/env.js";
import passport from "@/config/passport.js";
import { redisReady } from "@/config/redis.js";
import { runPurge } from "@/jobs/purge.js";
import { runSlaCheck } from "@/jobs/slaChecker.js";
import { logger, REDACT_PATHS } from "@/lib/logger.js";
import { metricsMiddleware, registry } from "@/lib/metrics.js";
import { pingDb } from "@/lib/prisma.js";
import { auth } from "@/middlewares/auth.js";
import { authorize } from "@/middlewares/authorize.js";
import { globalErrorHandler } from "@/middlewares/globalErrorHandler.js";
import { notFound } from "@/middlewares/notFound.js";
import { globalLimiter } from "@/middlewares/rateLimiter.js";
import { requestId } from "@/middlewares/requestId.js";
import { router } from "@/routes/index.js";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";
import { safeEqual } from "@/utils/crypto.js";
import { sendResponse } from "@/utils/sendResponse.js";

const app: Application = express();

// Render/Heroku style proxies: needed for correct req.ip in the rate limiters.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(requestId);

app.use(
	helmet({
		hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
		frameguard: { action: "deny" },
		referrerPolicy: { policy: "no-referrer" },
		crossOriginResourcePolicy: { policy: "same-site" },
		// Swagger UI needs inline styles/scripts to render.
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'", "'unsafe-inline'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				imgSrc: ["'self'", "data:", "https:"],
			},
		},
	}),
);

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));
// SSLCommerz posts its callbacks as form data.
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(hpp());
app.use(passport.initialize());

app.use(
	pinoHttp({
		logger,
		genReqId: (req) => (req as { id?: string }).id ?? "unknown",
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
		customLogLevel: (_req, res, err) => {
			if (err || res.statusCode >= 500) return "error";
			if (res.statusCode >= 400) return "warn";
			return "info";
		},
	}),
);

app.use(metricsMiddleware as RequestHandler);

// --- liveness / readiness ---------------------------------------------------
app.get("/health", (_req, res) => {
	sendResponse(res, { message: "OK", data: { uptime: process.uptime() } });
});

app.get("/ready", async (_req, res) => {
	const db = await pingDb();
	const redis = redisReady();

	if (!db) {
		res.status(503).json({
			success: false,
			message: "Service unavailable",
			errors: [{ code: "SERVICE_UNAVAILABLE", message: "Database is not reachable" }],
		});
		return;
	}

	sendResponse(res, { message: "Ready", data: { db, redis } });
});

// --- metrics (admin only) ---------------------------------------------------
app.get("/metrics", auth, authorize("ADMIN"), async (_req, res) => {
	res.setHeader("Content-Type", registry.contentType);
	res.send(await registry.metrics());
});

// --- api --------------------------------------------------------------------
app.use("/api/v1", globalLimiter, router);

app.get("/", (_req, res) => {
	sendResponse(res, {
		message: "CityCare API",
		data: { version: "1.0.0", docs: `${env.BACKEND_URL}/api/v1/docs`, health: "/health" },
	});
});

// --- scheduled jobs ---------------------------------------------------------
// node-cron needs a process that stays alive between requests. A serverless
// host has none, so its scheduler calls these over HTTP instead. The work is
// unchanged: `runSlaCheck` and `runPurge` are the very functions
// `startJobs()` schedules, so there is one implementation with two triggers.
const runJob = (job: "sla" | "purge") =>
	catchAsync(async (req: Request, res: Response) => {
		const provided = (req.headers.authorization ?? "").replace(/^Bearer /, "");
		// An unset secret rejects everything — the safe default for a host that
		// already runs the cron in-process and never needs these endpoints.
		if (!env.CRON_SECRET || !safeEqual(provided, env.CRON_SECRET)) {
			logger.warn({ job, ip: req.ip }, "rejected job trigger");
			throw new ApiError(401, "Unauthorized", [
				{ code: "UNAUTHORIZED", message: "Invalid cron secret" },
			]);
		}

		const data = job === "sla" ? await runSlaCheck() : await runPurge();
		logger.info({ job, data }, "scheduled job finished");
		sendResponse(res, { message: `${job} job finished`, data });
	});

// GET is what a platform scheduler sends; POST is here so a human can trigger
// one by hand without it reading like a safe, cacheable GET.
for (const method of ["get", "post"] as const) {
	app[method]("/internal/jobs/sla", runJob("sla"));
	app[method]("/internal/jobs/purge", runJob("purge"));
}

app.use(notFound);
app.use(globalErrorHandler);

export default app;
