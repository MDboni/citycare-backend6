import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../dist/app.js";
import { connectRedis } from "../dist/config/redis.js";

/**
 * The serverless entry point — used only by hosts that invoke a function per
 * request. `src/server.ts` is still the entry for every long-running host and
 * is deliberately NOT imported here: it calls `listen()` and starts node-cron,
 * neither of which means anything when the process dies after the response.
 *
 * It imports from `dist/`, not `src/`, so the `@/*` aliases are already
 * rewritten to real relative paths by `tsc-alias` and the platform's bundler
 * never has to learn about them.
 */

/**
 * Redis is built with `lazyConnect` and `enableOfflineQueue: false`, so the
 * first command on a cold instance would throw before the socket is up. One
 * connect per warm instance fixes that: the promise is cached, awaited by every
 * request, and never torn down — there is no shutdown in a serverless runtime.
 */
let ready: Promise<boolean> | null = null;

const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	ready ??= connectRedis();
	await ready;
	(app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
};

export default handler;
