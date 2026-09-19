import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, Router } from "express";
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
 * Swagger UI is a stylesheet and a script bundle, shipped as plain files
 * inside the `swagger-ui-dist` package. `swagger-ui-express` hands them to
 * `express.static`, which is right on a host that ships `node_modules` and
 * quietly wrong on a serverless one, where only the files the bundler traced
 * are deployed. pnpm compounds it: `swagger-ui-dist` never sits at the top of
 * `node_modules` but behind a symlink in the store, so no include glob reaches
 * it either. The failure was silent and total — every asset request fell
 * through to the catch-all handler and came back as the HTML page itself, so
 * the browser was handed `text/html` where it asked for CSS and JavaScript and
 * rendered nothing. A 200, and a blank screen.
 *
 * The page therefore names its assets outright, pinned to the version this
 * project resolves locally. Only the spec is read from disk.
 */
const UI_VERSION = "5.33.0";
const UI_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${UI_VERSION}`;

/**
 * The global policy allows scripts and styles from this origin only, which is
 * what every other route wants. This one page also needs the CDN above, so it
 * sets its own header — helmet ran earlier in the chain, and the last write to
 * `Content-Security-Policy` is the one the browser reads.
 *
 * The source is the CDN's origin, with no path. A CSP source whose path does
 * not end in "/" has to match the request path exactly, so naming the package
 * directory here would have allowed that one URL and blocked every file under
 * it — which is every file the page actually asks for.
 */
const UI_ORIGIN = "https://cdn.jsdelivr.net";

const DOCS_CSP = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline' ${UI_ORIGIN}`,
	`style-src 'self' 'unsafe-inline' ${UI_ORIGIN}`,
	`font-src 'self' data: ${UI_ORIGIN}`,
	"img-src 'self' data: https:",
	"connect-src 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
].join("; ");

const page = (specUrl: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CityCare API</title>
<link rel="stylesheet" href="${UI_BASE}/swagger-ui.css" />
<style>body { margin: 0; background: #fafafa; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="${UI_BASE}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script>
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: ${JSON.stringify(specUrl)},
    dom_id: "#swagger-ui",
    deepLinking: true,
    persistAuthorization: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
  });
};
</script>
</body>
</html>
`;

/**
 * Serves the hand-written OpenAPI document at /api/v1/docs. A missing or
 * broken spec must not stop the API from booting.
 */
export const mountSwagger = async (router: Router): Promise<void> => {
	try {
		const raw = await readSpec();
		const spec = parse(raw) as Record<string, unknown>;

		// An absolute path, not a relative one: `/docs` and `/docs/` are the same
		// route but resolve a relative URL to two different places.
		const specPath = (req: Request) => `${req.baseUrl}/docs/openapi.json`;

		router.get("/docs/openapi.json", (_req: Request, res: Response) => {
			res.json(spec);
		});

		router.get("/docs", (req: Request, res: Response) => {
			res.setHeader("Content-Security-Policy", DOCS_CSP);
			res.type("html").send(page(specPath(req)));
		});

		logger.info("Swagger UI mounted at /api/v1/docs");
	} catch (err) {
		logger.warn({ err: (err as Error).message }, "docs/openapi.yaml not loaded — /docs disabled");
	}
};
