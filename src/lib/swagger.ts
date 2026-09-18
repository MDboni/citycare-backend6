import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { parse } from "yaml";
import { logger } from "@/lib/logger.js";

const SPEC_PATH = path.resolve(process.cwd(), "docs", "openapi.yaml");

/**
 * Serves the hand-written OpenAPI document at /api/v1/docs. A missing or
 * broken spec must not stop the API from booting.
 */
export const mountSwagger = async (router: Router): Promise<void> => {
	try {
		const raw = await readFile(SPEC_PATH, "utf8");
		const spec = parse(raw) as Record<string, unknown>;
		router.use(
			"/docs",
			swaggerUi.serve,
			swaggerUi.setup(spec, {
				customSiteTitle: "CityCare API",
				swaggerOptions: { persistAuthorization: true },
			}),
		);
		logger.info("Swagger UI mounted at /api/v1/docs");
	} catch (err) {
		logger.warn({ err: (err as Error).message }, "docs/openapi.yaml not loaded — /docs disabled");
	}
};
