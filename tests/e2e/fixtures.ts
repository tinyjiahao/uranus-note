import { test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
export { expect, type Page } from "@playwright/test";

export async function openWorkspaceMenu(page: Page) {
  if (await page.getByRole("button", { name: "设置", exact: true }).isVisible()) return;
  await page.getByRole("button", { name: /^(笔记更多|更多)$/ }).click();
}

// Each local browser test represents a distinct client. The shared test account
// still has its own login budget, so local tests also honor Retry-After.
export const test = base.extend({
  page: async ({ page, baseURL }, use, testInfo) => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retriedLogin = false;
    // Exercise the shortest supported sync interval in general regression tests.
    // Dedicated sync tests override this to verify the production default.
    await page.addInitScript(() => {
      if (!localStorage.getItem("uranus.syncIntervalSeconds")) localStorage.setItem("uranus.syncIntervalSeconds", "5");
    });
    if (baseURL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
      await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "198.18." + Math.floor(Math.random() * 256) + "." + Math.floor(Math.random() * 256) });
      // Observe the real response instead of routing it: page.route disables
      // HTTP cache and would invalidate the attachment-cache regression.
      page.on("response", response => {
        if (!retriedLogin && new URL(page.url()).pathname === "/login" && new URL(response.url()).pathname === "/api/session" && response.request().method() === "POST" && response.status() === 429) {
          const seconds = Number(response.headers()["retry-after"]);
          if (Number.isFinite(seconds) && seconds > 0 && seconds <= 60) {
            retriedLogin = true;
            testInfo.setTimeout(testInfo.timeout + (seconds + 5) * 1000);
            retryTimer = setTimeout(() => {
              if (!page.isClosed()) void page.getByRole("button", { name: "登录", exact: true }).click().catch(() => { /* The test's workspace assertion reports a failed retry. */ });
            }, (seconds + 1) * 1000);
          }
        }
      });
    }
    try { await use(page); } finally { clearTimeout(retryTimer); }
  },
});
