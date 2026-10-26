import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: { UPGRADE_DB: "uranus-v2-upgrade-test" },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations/d1"),
          SESSION_SECRET: "test-session-secret-at-least-thirty-two-bytes-long",
          APP_ENV: "development",
          APP_ORIGIN: "http://uranus.test",
        },
      },
    })),
  ],
  test: { setupFiles: ["./tests/setup.ts"], include: ["tests/**/*.test.ts"] },
});
