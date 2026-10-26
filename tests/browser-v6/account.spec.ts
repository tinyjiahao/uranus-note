import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { uuidv7 } from "../../src/api/client";
const origin = "http://127.0.0.1:5186", password = "browser-fixture-password";
async function register(page: Page, prefix: string) {
  const email = prefix + "-" + Date.now() + "@example.test";
  await page.goto("/login");
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("用户名", { exact: true }).fill(prefix + "-" + Date.now());
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByText("注册成功，请登录", { exact: true })).toBeVisible();
  return email;
}
async function login(page: Page, email: string, value = password) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(value);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByTitle("新建笔记 (⌘N)")).toBeVisible();
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("账号与安全", { exact: true }).click();
}
async function session(context: BrowserContext) { return (await context.request.get(origin + "/api/session")).json(); }

test("two real browser contexts: direct registration, ownership, email/password revocation", async ({ browser }) => {
  const a = await browser.newContext({ baseURL: origin }), b = await browser.newContext({ baseURL: origin });
  try {
    const pa = await a.newPage(), pb = await b.newPage();
    const emailA = await register(pa, "alice"), emailB = await register(pb, "bob");
    await login(pa, emailA); await login(pb, emailB);
    await pa.getByTitle("新建笔记 (⌘N)").click();
    await pa.locator(".prose-editor").fill("Alice private browser content");
    await pa.keyboard.press("ControlOrMeta+s");
    await expect(pa.locator(".save-state")).toHaveText("已保存到服务器");
    const noteUrl = pa.url(), id = noteUrl.split("/").at(-1)!;
    await pb.goto(noteUrl);
    await expect(pb.getByText("笔记不存在或无权访问", { exact: true })).toBeVisible();
    await expect(pb.locator(".prose-editor")).toHaveCount(0);
    expect((await b.request.get(origin + "/api/notes/" + id)).status()).toBe(404);
    const listB = await b.request.get(origin + "/api/notes?q=Alice");
    expect((await listB.json()).items).toHaveLength(0);
    const sb = await session(b);
    expect((await b.request.patch(origin + "/api/notes/" + id, { headers: { Origin: origin, "X-CSRF-Token": sb.csrfToken }, data: { expected_revision: 1, content_schema_version: 5, operation_id: uuidv7(), starred: true } })).status()).toBe(404);
    await settings(pa);
    await pa.getByLabel("用户名", { exact: true }).fill("renamed-" + Date.now());
    await pa.getByRole("button", { name: "保存账号设置", exact: true }).click();
    await expect(pa.getByText("用户名已更新", { exact: true })).toBeVisible();
    const old = await session(a), oldCookie = (await a.cookies()).find(c => c.name === "uranus_session")!.value;
    await pa.getByRole("button", { name: "修改邮箱", exact: true }).click();
    const newEmail = "changed-" + Date.now() + "@example.test";
    await pa.getByLabel("新邮箱", { exact: true }).fill(newEmail);
    await pa.getByLabel("当前密码", { exact: true }).fill("wrong-password");
    await pa.getByRole("button", { name: "保存账号设置", exact: true }).click();
    await expect(pa.locator(".account-form [role=status]")).toContainText("密码");
    expect((await session(a)).user.email).toBe(emailA);
    await pa.getByLabel("当前密码", { exact: true }).fill(password);
    await pa.getByRole("button", { name: "保存账号设置", exact: true }).click();
    await expect(pa.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    expect((await a.request.get(origin + "/api/notes", { headers: { Cookie: "uranus_session=" + oldCookie } })).status()).toBe(401);
    await login(pa, newEmail);
    expect((await session(a)).user.id).toBe(old.user.id);
    await pa.goto(noteUrl); await expect(pa.locator(".prose-editor")).toContainText("Alice private browser content");
    await settings(pa); await pa.getByRole("button", { name: "修改密码", exact: true }).click();
    await pa.getByLabel("当前密码", { exact: true }).fill(password);
    await pa.getByLabel("新密码", { exact: true }).fill("changed-browser-password");
    await pa.getByLabel("确认密码", { exact: true }).fill("changed-browser-password");
    await pa.getByRole("button", { name: "保存账号设置", exact: true }).click();
    await expect(pa.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await login(pa, newEmail, "changed-browser-password");
    expect((await session(a)).user.id).toBe(old.user.id);
    expect((await session(b)).user.email).toBe(emailB);
  } finally { await a.close(); await b.close(); }
});

test("multi-tab invalidation preserves only same-user drafts", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin });
  try {
    const page = await context.newPage();
    const email = await register(page, "draft-owner");
    await login(page, email);
    await page.getByTitle("新建笔记 (⌘N)").click();
    await expect(page).toHaveURL(/\/notes\/[0-9]+$/);
    const url = page.url();
    // Keep this tab's pending edit local, including its visibility-change flush.
    await page.route("**/api/notes/*", route => route.request().method() === "PATCH" ? route.abort() : route.continue());
    await page.locator(".prose-editor").fill("UNSYNCED-A-ONLY");
    await expect(page.locator(".save-state")).toContainText("已存本机");
    const first = await session(context);
    const otherTab = await context.newPage();
    await otherTab.goto("/");
    // Avoid reopening the same note in tab B: that would test concurrent editor
    // conflicts rather than the identity boundary under test.
    await otherTab.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("uranus.lastNote.")) localStorage.removeItem(key); });
    await otherTab.goto("/");
    await expect(otherTab.getByTitle("退出", { exact: true })).toBeVisible();
    await otherTab.getByTitle("退出", { exact: true }).click();
    await expect(otherTab.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(page.locator(".prose-editor")).toHaveCount(0);
    const emailB = await register(otherTab, "draft-other");
    await login(otherTab, emailB);
    await otherTab.goto(url);
    await expect(otherTab.getByText("笔记不存在或无权访问", { exact: true })).toBeVisible();
    await expect(otherTab.getByText(/发现 .*本机未提交草稿/)).toHaveCount(0);
    const second = await session(context);
    expect(second.user.id).not.toBe(first.user.id);
    await otherTab.getByTitle("退出", { exact: true }).click();
    await page.unroute("**/api/notes/*");
    await login(page, email);
    await page.goto(url);
    await expect(page.getByRole("button", { name: "加载本地草稿", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "加载本地草稿", exact: true }).click();
    await expect(page.locator(".prose-editor")).toContainText("UNSYNCED-A-ONLY");
    await expect(page.locator(".save-state")).toHaveText("已保存到服务器");
  } finally { await context.close(); }
});

test("failed logout locks the editor without claiming revocation, and retry revokes", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin });
  try {
    const page = await context.newPage();
    const email = await register(page, "logout-retry");
    await login(page, email);
    const cookie = (await context.cookies()).find(c => c.name === "uranus_session")!.value;
    await page.route("**/api/session", route => route.request().method() === "DELETE" ? route.abort() : route.continue());
    await page.getByTitle("退出", { exact: true }).click();
    await expect(page.getByText("界面已锁定；仅在服务器确认后完成退出。", { exact: true })).toBeVisible();
    await expect(page.locator(".prose-editor")).toHaveCount(0);
    expect((await context.request.get(origin + "/api/notes", { headers: { Cookie: "uranus_session=" + cookie } })).status()).toBe(200);
    await page.unroute("**/api/session");
    await page.getByRole("button", { name: "重试退出", exact: true }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    expect((await context.request.get(origin + "/api/notes", { headers: { Cookie: "uranus_session=" + cookie } })).status()).toBe(401);
  } finally { await context.close(); }
});
