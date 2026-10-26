import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser-v6",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5186", trace: "off", ...devices["Desktop Chrome"], channel: "chrome" },
  webServer: { command: "node scripts/setup-v6-browser-check.mjs && npx wrangler dev --config tests/v6.wrangler.jsonc --persist-to .wrangler/v6-browser-check --ip 127.0.0.1 --port 5186", url: "http://127.0.0.1:5186/api/health", reuseExistingServer: true, timeout: 120_000 },
});
