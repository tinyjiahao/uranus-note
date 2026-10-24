import { test, expect, type Page } from "@playwright/test";
import { testApiToken } from "./credentials";

async function openNew(page: Page) {
  await page.goto("/login");
  await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
}
test("width, settings, selection, responsive layout and sorting preserve the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); await openNew(page);
  const editor = page.locator(".prose-editor"); await editor.fill("v2 宽度测试");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  let patches = 0; page.on("request", r => { if (r.method() === "PATCH") patches++; });
  await editor.click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+ArrowRight");
  const before = await page.evaluate(() => window.getSelection()?.toString());
  await page.getByTitle("切换舒适阅读").click();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(before);
  expect((await editor.boundingBox())!.width).toBeLessThanOrEqual(860);
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await expect(settings).toHaveCount(1);
  await expect(settings.locator("svg")).toHaveCSS("width", "18px");
  await expect(settings.locator("svg")).toHaveCSS("height", "18px");
  await settings.click();
  await page.getByLabel("编辑宽度").selectOption("fluid");
  await page.getByLabel("关闭设置").click();
  await expect(editor).toContainText("v2 宽度测试");
  await page.getByLabel("排序字段").selectOption("title");
  await page.getByLabel("排序方向").selectOption("asc");
  expect(patches).toBe(0);
  for (const layout of ["two", "focus", "three"]) {
    await settings.click(); await page.getByLabel("布局", { exact: true }).selectOption(layout); await page.getByLabel("关闭设置").click();
    await expect(settings).toHaveCount(1);
    await expect(settings).toBeVisible();
    await expect(settings).toBeFocused();
    const panel = (await page.locator(".editor-panel").boundingBox())!;
    expect((await editor.boundingBox())!.width).toBeCloseTo(panel.width, 0);
  }
  for (const width of [2560, 1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = (await page.locator(".editor-panel").boundingBox())!;
    const content = (await editor.boundingBox())!;
    expect(content.width).toBeCloseTo(panel.width, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await settings.click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await page.getByLabel("返回笔记列表").click(); await expect(page.locator(".note-list-panel")).toBeVisible();
  await expect(page.getByLabel("排序字段")).toHaveValue("title");
});

test("keyboard table insertion, last-cell Tab and ten-column narrow scrolling", async ({ page }) => {
  await openNew(page); const editor = page.locator(".prose-editor");
  const tableButton = page.getByRole("button", { name: "表格", exact: true });
  await tableButton.focus(); await tableButton.press("Enter");
  await page.getByLabel("表格行数").fill("1"); await page.getByLabel("表格列数").fill("1");
  await page.getByRole("button", { name: "插入", exact: true }).click();
  await editor.locator("th").click(); await page.keyboard.insertText("保留内容");
  await page.keyboard.press("Tab"); await expect(editor.locator("tr")).toHaveCount(2);
  await expect(editor.locator("tr").last().locator("td")).toHaveCount(1);
  await expect(page.locator(".table-tools")).toHaveCount(0);
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await page.getByLabel("当前列宽").fill("120"); await page.getByRole("button", { name: "应用列宽" }).click();
  for (let i = 0; i < 9; i++) await page.getByLabel("在表格右侧追加一列").click();
  await expect(editor.locator("tr").first().locator("td,th")).toHaveCount(10);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await editor.locator(".tableWrapper").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
});

test("table picker, widths, alignment, cancellation, undo, persistence and readonly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await openNew(page);
  const editor = page.locator(".prose-editor"); await editor.click();
  await page.getByRole("button", { name: "表格", exact: true }).click();
  await page.getByRole("button", { name: "3 行 4 列", exact: true }).click();
  await expect(editor.locator("tr")).toHaveCount(3);
  await editor.locator("th").first().click(); await page.keyboard.insertText("表头测试");
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await page.getByLabel("当前列宽").fill("220"); await page.getByRole("button", { name: "应用列宽" }).click();
  const firstWidth = await editor.locator("th").first().evaluate(el => el.getBoundingClientRect().width);
  expect(firstWidth).toBeCloseTo(220, 0);
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await page.getByRole("button", { name: "对齐", exact: true }).click();
  await page.getByLabel("水平对齐").selectOption("right"); await page.getByLabel("垂直对齐").selectOption("bottom");
  await page.getByRole("button", { name: "对齐", exact: true }).click();
  await expect(editor.locator("th").first()).toHaveCSS("text-align", "right");
  await editor.locator("th").first().click();
  await editor.locator("th").nth(1).click({ modifiers: ["Shift"] });
  await expect(editor.locator(".selectedCell")).toHaveCount(2);
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await page.getByRole("button", { name: "对齐", exact: true }).click();
  await expect(page.getByLabel("水平对齐")).toHaveValue("mixed");
  await page.getByLabel("水平对齐").selectOption("right");
  await page.getByRole("button", { name: "对齐", exact: true }).click();
  await editor.press("Backspace");
  await expect(editor.locator("tr")).toHaveCount(3);
  await expect(editor.locator("th").first()).toHaveText("");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor.locator("th").first()).toContainText("表头测试");
  await editor.locator("th").first().click();
  let rect = (await editor.locator("th").first().boundingBox())!;
  await page.mouse.move(rect.x + rect.width - 2, rect.y + 12); await page.mouse.down(); await page.mouse.move(rect.x + rect.width + 70, rect.y + 12); await page.keyboard.press("Escape"); await page.mouse.up();
  expect((await editor.locator("th").first().boundingBox())!.width).toBeCloseTo(220, 0);
  rect = (await editor.locator("th").first().boundingBox())!;
  await page.mouse.move(rect.x + rect.width - 2, rect.y + 12); await page.mouse.down(); await page.mouse.move(rect.x + rect.width + 70, rect.y + 12); await page.mouse.up();
  expect((await editor.locator("th").first().boundingBox())!.width).toBeGreaterThan(250);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect((await editor.locator("th").first().boundingBox())!.width).toBeCloseTo(220, 0);
  await page.getByLabel("在表格底部追加一行").click(); await expect(editor.locator("tr")).toHaveCount(4);
  await page.getByLabel("在表格右侧追加一列").click(); await expect(editor.locator("tr").first().locator("th,td")).toHaveCount(5);
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await page.getByRole("button", { name: "在表格下方继续输入" }).click(); await page.keyboard.insertText("表格后的正文");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible(); await page.reload();
  await expect(editor).toContainText("表格后的正文"); await expect(editor.locator("th").first()).toHaveCSS("text-align", "right");
  expect((await editor.locator("th").first().boundingBox())!.width).toBeCloseTo(220, 0);
  await page.getByRole("button", { name: "只读模式", exact: true }).click(); await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".table-tools")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test("table edge handles insert in place and row menus preserve selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await openNew(page);
  const editor = page.locator(".prose-editor");
  await page.getByRole("button", { name: "表格", exact: true }).click();
  await page.getByRole("button", { name: "3 行 4 列", exact: true }).click();
  await editor.locator("th").first().fill("边缘操作测试");
  await page.getByRole("button", { name: "在第 2 行位置插入", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.locator("tr")).toHaveCount(4);
  await page.getByRole("button", { name: "第 2 行菜单", exact: true }).click();
  await expect(editor.locator(".selectedCell")).toHaveCount(4);
  await page.getByRole("button", { name: "删除所选行", exact: true }).click();
  await expect(editor.locator("tr")).toHaveCount(3);
  await page.getByRole("button", { name: "第 2 列菜单", exact: true }).click();
  await expect(editor.locator(".selectedCell")).toHaveCount(3);
  await page.getByRole("button", { name: "右侧插列", exact: true }).click();
  await expect(editor.locator("tr").first().locator("th,td")).toHaveCount(5);
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "表格操作" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "表格菜单", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "在第 3 行位置插入", exact: true }).focus();
  await page.screenshot({ path: "test-results/table-edge-desktop.png" });
  const table = (await editor.locator("table").boundingBox())!;
  const add = (await page.getByLabel("在表格右侧追加一列").boundingBox())!;
  expect(add.x - table.x - table.width).toBeLessThan(8);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await page.getByLabel("关闭设置").click();
  await page.getByRole("button", { name: "在第 3 行位置插入", exact: true }).focus();
  await page.screenshot({ path: "test-results/table-edge-dark.png" });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  const menu = (await page.getByRole("dialog", { name: "表格操作" }).boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: "test-results/table-edge-mobile.png" });
});

test("network failures acknowledge only confirmed local drafts and retry safely", async ({ page }) => {
  await openNew(page);
  await page.route("**/api/notes/*", route => route.request().method() === "PATCH" ? route.abort("internetdisconnected") : route.continue());
  await page.locator(".prose-editor").fill("未同步的正文");
  await expect(page.locator(".save-state")).toContainText("未同步，草稿已暂存此浏览器", { timeout: 12_000 });
  await page.unroute("**/api/notes/*"); await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator(".prose-editor")).toContainText("未同步的正文");
});

test("failed IndexedDB and network expose manual copy, and failed preferences remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = () => { throw new Error("test storage unavailable"); };
    Storage.prototype.setItem = () => { throw new Error("test preferences unavailable"); };
    navigator.clipboard.writeText = async () => { throw new Error("test clipboard unavailable"); };
  });
  await openNew(page);
  await page.route("**/api/notes/*", route => route.request().method() === "PATCH" ? route.abort() : route.continue());
  await page.locator(".prose-editor").fill("需要手工保存");
  await expect(page.locator(".save-state")).toContainText("内容尚未安全保存", { timeout: 12_000 });
  await page.getByRole("button", { name: "复制未保存内容" }).click();
  await expect(page.getByLabel("未保存内容", { exact: true })).toContainText("需要手工保存");
  await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByLabel("编辑宽度").selectOption("reading");
  await expect(page.getByRole("dialog")).toContainText("无法记忆偏好"); await page.keyboard.press("Escape");
  await expect(page.locator(".editor-shell")).toHaveClass(/width-reading/);
});

test("soft delete undo uses the server and expired sessions conceal content", async ({ page }) => {
  await openNew(page); const editor = page.locator(".prose-editor");
  await editor.fill("删除与恢复测试"); await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.getByTitle("移到最近删除").click();
  await page.locator(".notice").getByRole("button", { name: "撤销" }).click();
  await expect(editor).toContainText("删除与恢复测试");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.route("**/api/session", route => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/notes/*", route => route.request().method() === "PATCH" ? route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "请先登录" } } }) : route.continue());
  await editor.fill("会话过期后不能公开显示");
  await expect(page).toHaveURL(/\/login$/); await expect(editor).toHaveCount(0);
  await expect(page.getByLabel("访问令牌")).toBeVisible();
});

test("permanent deletion reports queued, failed and confirmed completion separately", async ({ page }) => {
  await openNew(page); const url = page.url();
  await page.locator(".prose-editor").fill("仅用于永久删除验收");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.getByTitle("移到最近删除").click(); await expect(page.locator(".notice")).toContainText("已移到最近删除");
  await page.goto(url); await expect(page.locator(".prose-editor")).toHaveAttribute("contenteditable", "false");
  let reads = 0; let retried = false;
  await page.route("**/api/maintenance/jobs/**", async route => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON().operation_id).toMatch(/^[0-9a-f-]{36}$/); retried = true;
      return route.fulfill({ json: { id: "test-job", status: "queued" } });
    }
    return route.fulfill({ json: { id: "test-job", status: retried ? "succeeded" : ++reads === 1 ? "queued" : "failed" } });
  });
  page.once("dialog", dialog => { expect(dialog.message()).toContain("不能撤销"); void dialog.accept(); });
  await page.getByTitle("永久删除").click(); await expect(page.locator(".notice")).toContainText("正在处理中");
  await expect(page.locator(".notice")).toContainText("删除任务失败", { timeout: 10_000 });
  await page.getByRole("button", { name: "重试删除任务" }).click();
  await expect(page.locator(".notice")).toContainText("永久删除任务已完成");
});
