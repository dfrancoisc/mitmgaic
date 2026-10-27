import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Keep tests offline and free: AI and Vectorize are only reachable remotely, so tests
			// exercise them through fakes or the keyword fallback instead.
			remoteBindings: false,
			miniflare: {
				bindings: {
					ANTHROPIC_API_KEY: "test-key",
					AGENT_SECRET: "test-agent-secret",
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
				},
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
