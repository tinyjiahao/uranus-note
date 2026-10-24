import { expect, test } from "@playwright/test";
import { testApiToken } from "./credentials";

test("paragraph and heading alignment supports selection, undo, persistence and readonly", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const editor = page.locator(".prose-editor");
  await editor.fill("第一段"); await editor.press("Enter"); await page.keyboard.insertText("第二段");
  await editor.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "居中对齐", exact: true }).click();
  await expect(editor.locator("p").first()).toHaveCSS("text-align", "center");
  await expect(editor.locator("p").last()).toHaveCSS("text-align", "center");
  await editor.locator("p").first().click();
  await page.getByRole("button", { name: "标题 1", exact: true }).click();
  await page.getByRole("button", { name: "靠右对齐", exact: true }).click();
  await expect(editor.locator("h1")).toHaveCSS("text-align", "right");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor.locator("h1")).toHaveCSS("text-align", "center");
  await page.getByRole("button", { name: "靠左对齐", exact: true }).click();
  await expect(editor.locator("h1")).toHaveCSS("text-align", "left");
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.reload();
  await expect(editor.locator("h1")).toHaveCSS("text-align", "left");
  await expect(editor.locator("p").last()).toHaveCSS("text-align", "center");
  await page.getByRole("button", { name: "只读模式", exact: true }).click();
  for (const name of ["靠左对齐", "居中对齐", "靠右对齐"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
});
