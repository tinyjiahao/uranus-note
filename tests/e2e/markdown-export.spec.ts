import { readFile } from "node:fs/promises";
import type { Editor } from "@tiptap/core";
import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
test("downloads legacy Markdown source without escaping table delimiters or complete inline syntax", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const body = page.locator(".prose-editor");
  await expect(body).toBeVisible();
  await page.getByLabel("笔记标题", { exact: true }).fill("Markdown export regression");
  await body.evaluate(element => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    editor.commands.setContent({ type: "doc", content: ["| 编号 | 需求 |", "| --- | --- |", "| V12 | **P0** `created_at` |", "**批次零**：修复"].map(text => ({ type: "paragraph", content: [{ type: "text", text }] })) });
  });
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.getByRole("button", { name: "笔记更多", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
  const download = await pending, markdown = await readFile((await download.path())!, "utf8");
  expect(markdown).toContain("| 编号 | 需求 |\n| --- | --- |\n| V12 | **P0** `created_at` |");
  expect(markdown).toContain("**批次零**：修复");
  expect(markdown).not.toContain("\\|");
});
