import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

for (const width of [320, 390, 767]) test(`mobile notebook navigation at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const picker = page.getByLabel("选择笔记本", { exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.locator('option[value^="folder:"]').first()).toBeAttached();
  const folder = await picker.locator('option[value^="folder:"]').first().getAttribute("value");
  await expect(picker).toHaveValue(folder!);
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await expect(page.locator(".prose-editor")).toBeVisible();
  if (width === 390) {
    const body = page.locator(".prose-editor");
    await body.fill("用于验证长笔记编辑的正文 ".repeat(250));
    await page.setViewportSize({ width, height: 430 });
    await page.locator(".editor-content").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => page.locator(".editor-content").evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    await expect(page.getByRole("button", { name: "返回笔记列表" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "笔记更多" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeInViewport();
    // Model a standalone keyboard pan that changes the document position
    // without changing the visual viewport's layout-relative offset.
    const workspace = page.locator(".workspace");
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "pageTop", { configurable: true, value: 140 });
      window.dispatchEvent(new Event("scroll"));
    });
    await expect(workspace).toHaveCSS("top", "140px");
    await page.evaluate(() => {
      document.activeElement instanceof HTMLElement && document.activeElement.blur();
      // Simulate WebKit publishing the settled offset after focusout.
      setTimeout(() => Reflect.deleteProperty(window.visualViewport!, "pageTop"), 50);
    });
    await expect(workspace).toHaveCSS("top", "0px");
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "返回笔记列表" })).toBeInViewport();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(body).not.toContainText("用于验证长笔记");
  }
  await page.getByRole("button", { name: "返回笔记列表", exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(page.locator(".note-row").first()).toBeVisible();
  await picker.selectOption("all");
  await expect(page.locator(".note-row").first()).toBeVisible();
  await picker.selectOption("starred");
  await expect(picker).toHaveValue("starred");
  await picker.selectOption("trash");
  await expect(picker).toHaveValue("trash");
  await picker.selectOption(folder!);
  await page.locator(".note-row").first().click();
  await page.reload();
  await expect(page.locator(".prose-editor")).toBeVisible();
  await page.getByRole("button", { name: "返回笔记列表", exact: true }).click();
  await expect(picker).toHaveValue(folder!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("recently opened notes retain order and body scroll across reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();

  const newNote = page.getByRole("button", { name: "新建笔记", exact: true });
  const back = page.getByRole("button", { name: "返回笔记列表", exact: true });
  const picker = page.getByLabel("选择笔记本", { exact: true });
  const body = page.locator(".prose-editor");
  const scroller = page.locator(".editor-content");

  await newNote.click();
  await page.getByLabel("笔记标题", { exact: true }).fill("阅读位置回归 A");
  await body.fill("用于滚动恢复的长正文 ".repeat(300));
  await body.press("ControlOrMeta+s");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await scroller.evaluate(element => { element.scrollTop = 400; });
  await expect(scroller).toHaveJSProperty("scrollTop", 400);
  await back.click();

  await newNote.click();
  await page.getByLabel("笔记标题", { exact: true }).fill("阅读位置回归 B");
  await page.getByLabel("笔记标题", { exact: true }).press("ControlOrMeta+s");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await back.click();
  await page.reload();
  await picker.selectOption("recent");
  const titles = page.locator(".note-row-title strong");
  await expect(titles).toHaveText(["阅读位置回归 B", "阅读位置回归 A"]);
  await titles.nth(1).click();
  await expect(scroller).toHaveJSProperty("scrollTop", 400);
  await page.reload();
  await expect(scroller).toHaveJSProperty("scrollTop", 400);
  await back.click();
  await picker.selectOption("recent");
  await expect(titles).toHaveText(["阅读位置回归 A", "阅读位置回归 B"]);
});
