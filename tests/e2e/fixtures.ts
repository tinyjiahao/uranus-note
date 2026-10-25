import { test as base } from "@playwright/test";
export { expect, type Page } from "@playwright/test";

// Each local browser test represents a distinct client. This avoids unrelated
// tests consuming the same ten-per-minute login budget. Production rate-limit
// middleware is unchanged; non-loopback test URLs do not receive this header.
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    if (baseURL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
      await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "198.18." + Math.floor(Math.random() * 256) + "." + Math.floor(Math.random() * 256) });
    }
    await use(page);
  },
});
