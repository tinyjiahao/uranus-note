import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("body blocks reorder, undo, cancel, and persist without changing their contents", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const body = page.locator(".prose-editor");
  await body.evaluate(element => {
    const editor = (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor;
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    editor.commands.setContent({ type: "doc", content: [
      paragraph("第一段"), { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "第二块" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("列表项目")] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [paragraph("有序项目")] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("已完成任务")] }] },
      { type: "blockquote", content: [paragraph("引用内容")] },
      { type: "codeBlock", content: [{ type: "text", text: "const value = 1;" }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("单元格")] }] }] },
      { type: "horizontalRule" }, paragraph("末尾"),
    ] });
  });
  const json = () => body.evaluate(element => (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.getJSON());
  const before = await json();
  const handle = body.getByRole("button", { name: "拖动段落", exact: true }).first();
  const from = (await handle.boundingBox())!;
  const heading = (await body.locator("h2").boundingBox())!;
  await page.mouse.move(from.x + 12, from.y + 10); await page.mouse.down();
  await page.mouse.move(heading.x + 40, heading.y + heading.height - 1, { steps: 8 });
  await expect(page.locator(".block-drop-guide")).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => (await json()).content?.[0]?.type).toBe("heading");
  expect((await json()).content).toEqual([before.content![1], before.content![0], ...before.content!.slice(2)]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(json).toEqual(before);
  const cancelHandle = (await handle.boundingBox())!;
  await page.mouse.move(cancelHandle.x + 12, cancelHandle.y + 10); await page.mouse.down();
  await page.mouse.move(heading.x + 40, heading.y + heading.height - 1, { steps: 8 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.locator(".block-drop-guide")).toHaveCount(0);
  expect(await json()).toEqual(before);
  // Keyboard movement uses the same command and preserves each complex subtree.
  for (const label of ["标题", "无序列表", "有序列表", "任务列表", "引用", "代码块", "表格", "分隔线"]) {
    const snapshot = await json();
    await body.getByRole("button", { name: `拖动${label}`, exact: true }).press("Alt+ArrowUp");
    expect(await json()).not.toEqual(snapshot);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(json).toEqual(snapshot);
  }
  await body.getByRole("button", { name: "拖动表格", exact: true }).press("Alt+ArrowUp");
  const moved = await json();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect.poll(json).toEqual(moved);
  await page.getByRole("button", { name: "只读模式", exact: true }).click();
  await expect(body.locator(".block-drag-handle")).toHaveCount(0);
});
