import client from "prom-client";

/**
 * Prometheus metrics, exposed at /metrics behind an ADMIN token.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "citycare_" });

export const httpRequests = new client.Counter({
	name: "citycare_http_requests_total",
	help: "Total HTTP requests",
	labelNames: ["method", "route", "status"] as const,
	registers: [registry],
});

export const httpDuration = new client.Histogram({
	name: "citycare_http_request_duration_seconds",
	help: "HTTP request duration in seconds",
	labelNames: ["method", "route", "status"] as const,
	buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
	registers: [registry],
});

export const otpCounter = new client.Counter({
	name: "citycare_otp_total",
	help: "OTP emails by outcome",
	labelNames: ["kind", "outcome"] as const,
	registers: [registry],
});

export const paymentCounter = new client.Counter({
	name: "citycare_payments_total",
	help: "Payments by outcome",
	labelNames: ["outcome"] as const,
	registers: [registry],
});

export const openComplaints = new client.Gauge({
	name: "citycare_open_complaints",
	help: "Complaints currently in an open status",
	registers: [registry],
});

/** Timing middleware — uses the route pattern, never the raw URL (no ids). */
export const metricsMiddleware = (
	req: { method: string; route?: { path?: string }; baseUrl?: string },
	res: { statusCode: number; on: (e: string, cb: () => void) => void },
	next: () => void,
): void => {
	const end = httpDuration.startTimer();
	res.on("finish", () => {
		const route = `${req.baseUrl ?? ""}${req.route?.path ?? ""}` || "unknown";
		const labels = { method: req.method, route, status: String(res.statusCode) };
		end(labels);
		httpRequests.inc(labels);
	});
	next();
};
