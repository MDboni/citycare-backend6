import app from "@/app.js";
import { env } from "@/config/env.js";
import { connectRedis, redis } from "@/config/redis.js";
import { startJobs, stopJobs } from "@/jobs/index.js";
import { logger } from "@/lib/logger.js";
import { verifyMailer } from "@/lib/mailer.js";
import { connectDb, disconnectDb } from "@/lib/prisma.js";

const bootstrap = async (): Promise<void> => {
	await connectDb();
	await connectRedis();
	await verifyMailer();

	const server = app.listen(env.PORT, () => {
		logger.info({ port: env.PORT, env: env.NODE_ENV }, `CityCare API listening on :${env.PORT}`);
	});

	// Slowloris protection: a client cannot hold a socket open for ever.
	server.headersTimeout = 15_000;
	server.requestTimeout = 30_000;

	startJobs();

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info({ signal }, "shutting down");

		// Hard stop if a connection refuses to drain.
		const force = setTimeout(() => {
			logger.error("forced shutdown after 10s");
			process.exit(1);
		}, 10_000);
		force.unref();

		stopJobs();
		server.close(async () => {
			try {
				await disconnectDb();
				await redis.quit();
			} catch (err) {
				logger.error({ err }, "error during shutdown");
			}
			clearTimeout(force);
			process.exit(0);
		});
	};

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => void shutdown(signal));
	}

	process.on("unhandledRejection", (reason) => {
		logger.fatal({ reason }, "unhandled rejection");
		void shutdown("unhandledRejection");
	});

	process.on("uncaughtException", (err) => {
		logger.fatal({ err }, "uncaught exception");
		void shutdown("uncaughtException");
	});
};

bootstrap().catch((err) => {
	logger.fatal({ err }, "failed to start server");
	process.exit(1);
});
