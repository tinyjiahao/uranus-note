import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

const baseURL = loadEnv("test", ".", "URANUS_").URANUS_TEST_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: "npm run db:migrate:local && npm run build && npm run preview -- --host 127.0.0.1",
    url: `${baseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
