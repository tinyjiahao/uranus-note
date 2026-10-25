import { expect, test, type Page } from "./fixtures";
import { testApiToken } from "./credentials";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("关于与部署", { exact: true }).click();
}

test("install manifest and PNG assets are public, correctly typed and have actual dimensions", async ({ page, request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", name: "Uranus Notes" });
  expect(JSON.stringify(manifest)).not.toContain("searchdiff.com");
  const icons = [...manifest.icons, { src: "/icons/apple-touch-icon.png", sizes: "180x180" }];
  for (const icon of icons) {
    expect(icon.src).toMatch(/^\/icons\//);
    const image = await request.get(icon.src);
    expect(image.status()).toBe(200); expect(image.headers()["content-type"]).toContain("image/png");
    const bytes = await image.body();
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
  }
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(true);
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test("install offer survives settings reopening; cancellation and failure preserve editing", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("button", { name: "安装 Uranus", exact: true })).toHaveCount(0);
  await expect(page.getByText("如何安装", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  await page.getByRole("textbox", { name: "笔记标题", exact: true }).fill("安装取消不丢失");
  await page.locator(".prose-editor").fill("安装测试正文");
  await page.evaluate(() => {
    (window as unknown as { promptCalls: number }).promptCalls = 0;
    window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => { (window as unknown as { promptCalls: number }).promptCalls++; },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    }));
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("关于与部署", { exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { promptCalls: number }).promptCalls)).toBe(0);
  await page.getByRole("button", { name: "安装 Uranus", exact: true }).click();
  await expect(page.getByText("已取消安装，仍可继续使用网页版。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "安装应用" })).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { promptCalls: number }).promptCalls)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: async () => { throw new Error("test failure"); }, userChoice: Promise.resolve({ outcome: "dismissed" }),
  })));
  await page.getByRole("button", { name: "安装 Uranus", exact: true }).click();
  await expect(page.getByText("无法打开安装提示，请按下方指引手工安装。", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("install-guide.png") });
  await page.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue("安装取消不丢失");
  await expect(page.locator(".prose-editor")).toHaveText("安装测试正文");
  await expect(page.locator(".save-state")).toHaveText("已保存到服务器");
  await page.reload();
  await expect(page.locator(".prose-editor")).toHaveText("安装测试正文");
});

test("standalone simulation hides installation action without changing login", async ({ page }) => {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = matchMedia(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
  await login(page);
  await expect(page.getByText("当前以独立窗口运行", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "安装 Uranus", exact: true })).toHaveCount(0);
});
