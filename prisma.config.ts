import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
	// Multi-file schema: every *.prisma file inside prisma/schema is merged.
	schema: "prisma/schema",
	migrations: {
		path: "prisma/migrations",
		seed: "tsx prisma/seed.ts",
	},
	datasource: {
		url: env("DATABASE_URL"),
	},
});
