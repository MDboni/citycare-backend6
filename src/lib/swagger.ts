import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { parse } from "yaml";
import { logger } from "@/lib/logger.js";

/**
 * Two candidates, because the right answer depends on the host. A long-running
 * server is started from the project root, so cwd finds the file. A serverless
 * function is invoked with a working directory nobody promised — but the spec
 * keeps its place relative to this module, since `src/lib/` and `dist/lib/`
 * are both two levels under the root. Whichever host this is, one of them hits.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

const SPEC_PATHS = [
	path.resolve(here, "..", "..", "docs", "openapi.yaml"),
	path.resolve(process.cwd(), "docs", "openapi.yaml"),
];

const readSpec = async (): Promise<string> => {
	let last: unknown;
	for (const candidate of SPEC_PATHS) {
		try {
			return await readFile(candidate, "utf8");
		} catch (err) {
			last = err;
		}
	}
	throw last;
};

/**
 * Serves the hand-written OpenAPI document at /api/v1/docs. A missing or
 * broken spec must not stop the API from booting.
 */
export const mountSwagger = async (router: Router): Promise<void> => {
	try {
		const raw = await readSpec();
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
