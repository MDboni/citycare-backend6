import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,
		setupFiles: ["./tests/setup.ts"],
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 120_000,
		// Integration tests share one database, so they must not race each other.
		pool: "forks",
		// minWorkers was here too; vitest 5 dropped it from InlineConfig, and with
		// one worker and no file parallelism it said nothing extra anyway.
		maxWorkers: 1,
		fileParallelism: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			include: ["src/utils/**", "src/modules/**/*.service.ts"],
		},
	},
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
});
