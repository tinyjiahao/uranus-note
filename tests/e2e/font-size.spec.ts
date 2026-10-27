import { openWorkspaceMenu } from "./fixtures";
import { expect, test } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("editor font size is a persistent local preference, not a content edit", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const editor = page.locator(".prose-editor");
  await expect(editor).toHaveCSS("font-size", "14px");
  await editor.fill("字号显示测试");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  let patches = 0; page.on("request", r => { if (r.method() === "PATCH") patches++; });
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await openWorkspaceMenu(page); await settings.click();
  for (const size of [16, 18, 20, 14, 18]) {
    await page.getByLabel("编辑器字号").selectOption(String(size));
    await expect(editor).toHaveCSS("font-size", `${size}px`);
  }
  await page.getByLabel("关闭设置").click();
  await expect(editor).toHaveText("字号显示测试");
  await page.reload();
  await expect(editor).toHaveCSS("font-size", "18px");
  await page.getByRole("button", { name: "只读模式", exact: true }).click();
  await openWorkspaceMenu(page); await settings.click(); await page.getByLabel("编辑器字号").selectOption("20");
  await expect(editor).toHaveCSS("font-size", "20px");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "恢复默认偏好" }).click();
  await expect(editor).toHaveCSS("font-size", "14px");
  await page.getByLabel("关闭设置").click();
  await page.reload(); await expect(editor).toHaveCSS("font-size", "14px");
  expect(patches).toBe(0);
});
