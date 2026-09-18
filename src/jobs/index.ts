import cron, { type ScheduledTask } from "node-cron";
import { isTest } from "@/config/env.js";
import { runPurge } from "@/jobs/purge.js";
import { runSlaCheck } from "@/jobs/slaChecker.js";
import { logger } from "@/lib/logger.js";

const tasks: ScheduledTask[] = [];

/** A crashing job must never take the process down with it. */
const guard = (name: string, fn: () => Promise<unknown>) => async () => {
	try {
		await fn();
	} catch (err) {
		logger.error({ err, job: name }, "scheduled job failed");
	}
};

export const startJobs = (): void => {
	if (isTest) return;

	// Hourly: SLA escalation + auto-close.
	tasks.push(cron.schedule("0 * * * *", guard("sla-check", runSlaCheck), { timezone: "UTC" }));

	// Daily at 03:15 UTC: retention purge.
	tasks.push(cron.schedule("15 3 * * *", guard("purge", runPurge), { timezone: "UTC" }));

	logger.info({ jobs: tasks.length }, "cron jobs scheduled");
};

export const stopJobs = (): void => {
	for (const task of tasks) void task.stop();
	tasks.length = 0;
};

export { runPurge, runSlaCheck };
