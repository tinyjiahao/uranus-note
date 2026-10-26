// This suite verifies the production 30s default, not the general 5s fixture.
import { expect, test, type Page } from "@playwright/test";
import { testEmail, testPassword } from "./credentials";

async function open(page: Page) {
  if (process.env.URANUS_SYNC_DIAGNOSTICS === "1") {
    page.on("console", message => { if (message.text().startsWith("SYNC_DIAGNOSTIC")) console.log(message.text()); });
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = function (input, init) {
        if (init?.method === "PATCH") console.debug("SYNC_DIAGNOSTIC", document.visibilityState, localStorage.getItem("uranus.syncIntervalSeconds"), new Error().stack);
        return original.call(this, input, init);
      };
    });
  }
  await page.addInitScript(() => localStorage.removeItem("uranus.syncIntervalSeconds"));
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
}

test("local draft, configurable remote sync, and settings blur remain separate", async ({ page }) => {
  await open(page);
  const patches: string[] = [];
  page.on("request", request => { if (request.method() === "PATCH" && request.url().includes("/api/notes/")) patches.push(request.url()); });
  await page.locator(".prose-editor").fill("先保存本机的正文");
  await expect(page.locator(".save-state")).toContainText("已存本机");
  expect(patches).toHaveLength(0);
  const noteId = Number(page.url().split("/").at(-1));
  const userId = (await (await page.request.get("/api/session")).json()).user.id as string;
  const draft = await page.evaluate(async ({ id, userId }) => new Promise<{ content: unknown }>((resolve, reject) => {
    const request = indexedDB.open("uranus-drafts-v6:" + userId, 1);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("drafts").objectStore("drafts").get(id);
      get.onsuccess = () => { resolve(get.result); db.close(); };
      get.onerror = () => reject(get.error);
    };
    request.onerror = () => reject(request.error);
  }), { id: noteId, userId });
  expect(JSON.stringify(draft.content)).toContain("先保存本机的正文");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const interval = page.getByLabel("远程同步间隔（秒）");
  await expect(interval).toHaveValue("30");
  expect(patches).toHaveLength(0);
  await interval.fill("5");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.locator(".save-state")).toContainText("已保存到服务器", { timeout: 10_000 });
  expect(patches).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("uranus.syncIntervalSeconds"))).toBe("5");
});

test("shortcut and switching notes flush before the remote interval", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await editor.fill("快捷键立即同步");
  const first = page.waitForResponse(r => r.request().method() === "PATCH");
  await page.keyboard.press("ControlOrMeta+s");
  expect((await first).ok()).toBe(true);
  await editor.fill("切换笔记立即同步");
  const switched = page.waitForResponse(r => r.request().method() === "PATCH");
  await page.getByTitle("新建笔记 (⌘N)").click();
  expect((await switched).ok()).toBe(true);
});

test("offline draft retries on reconnect without losing edits", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("远程同步间隔（秒）").fill("5");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.route("**/api/notes/*", route => route.request().method() === "PATCH" ? route.abort() : route.continue());
  await page.locator(".prose-editor").fill("断网本机草稿");
  await expect(page.locator(".save-state")).toContainText("已存本机");
  await expect(page.locator(".save-state")).toContainText("未同步，草稿已暂存", { timeout: 12_000 });
  await page.unroute("**/api/notes/*");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(page.locator(".prose-editor")).toContainText("断网本机草稿");
});
