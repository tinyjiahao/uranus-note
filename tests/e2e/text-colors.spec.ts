import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
import type { Editor } from "@tiptap/core";
test.use({ trace: "off" });

test("text and highlight colors combine, round-trip HTML, persist and clear independently", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const body = page.locator(".prose-editor");
  await expect(body).toBeVisible();
  await page.getByLabel("笔记标题", { exact: true }).fill("颜色测试");
  await body.fill("new page");
  const select = () => body.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.selectAll());
  await select();
  await page.getByRole("button", { name: "文本颜色与突出显示", exact: true }).click();
  const trigger = page.getByRole("button", { name: "文本颜色与突出显示", exact: true });
  const popup = page.locator(".text-colors-popup");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const buttonBox = (await trigger.boundingBox())!, popupBox = (await popup.boundingBox())!;
    expect(Math.abs(popupBox.y - buttonBox.y - buttonBox.height - 6)).toBeLessThan(2);
    expect(Math.abs(popupBox.x - buttonBox.x)).toBeLessThan(2);
    for (const reset of await popup.locator('.color-reset-button').all()) {
      await expect(reset).toHaveCSS('border-top-style', 'solid');
      expect(await reset.evaluate(el => getComputedStyle(el).backgroundColor !== getComputedStyle(el.closest('.object-popup')!).backgroundColor)).toBe(true);
      await expect(reset.locator('svg')).toBeVisible();
    }
  }
  await expect(page.getByRole("group", { name: "文本颜色", exact: true }).getByRole("button")).toHaveCount(30);
  await page.getByRole("group", { name: "文本颜色", exact: true }).getByRole("button", { name: "深蓝色", exact: true }).click();
  await page.getByRole("group", { name: "突出显示颜色", exact: true }).getByRole("button", { name: "绿色", exact: true }).click();
  await expect(body.locator("mark")).toHaveCSS("background-color", "rgb(186, 243, 219)");
  await expect(body.locator('span[style*="color"]')).toHaveCSS("color", "rgb(24, 88, 188)");
  await page.keyboard.press("Escape");
  // Clipboard HTML parsing must preserve both marks, including browser rgb normalization.
  await select();
  await body.evaluate(element => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    const clipboardData = new DataTransfer(); clipboardData.setData("text/html", editor.getHTML());
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(body.locator("mark")).toHaveCSS("background-color", "rgb(186, 243, 219)");
  await expect(body.locator('span[style*="color"]')).toHaveCSS("color", "rgb(24, 88, 188)");
  await select();
  await page.getByRole("button", { name: "文本颜色与突出显示", exact: true }).click();
  await page.screenshot({ path: "test-results/text-colors.png" });
  await page.getByRole("button", { name: "清除突出显示", exact: true }).click();
  await expect(body.locator("mark")).toHaveCount(0);
  await expect(body.locator('span[style*="color"]')).toHaveCSS("color", "rgb(24, 88, 188)");
  await page.getByRole("button", { name: "默认文本颜色", exact: true }).click();
  await expect(body.locator('span[style*="color"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const palette = page.locator(".text-colors-popup");
  expect(await palette.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
