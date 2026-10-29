import { expect, test } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
import type { Editor } from "@tiptap/core";

test("tasks align checkbox and text together in body and table cells", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const body = page.locator(".prose-editor");
  await body.evaluate(el => {
    const editor = (el as HTMLElement & { editor: Editor }).editor;
    const paragraph = (text: string, textAlign = "center") => ({ type: "paragraph", attrs: { textAlign }, content: [{ type: "text", text }] });
    const tasks = { type: "taskList", content: ["left", "center", "right"].map(textAlign => ({ type: "taskItem", attrs: { checked: textAlign === "left" }, content: [paragraph(textAlign, textAlign)] })) };
    editor.commands.setContent({ type: "doc", content: [tasks, { type: "table", content: [{ type: "tableRow", content: [{
      type: "tableCell", attrs: { textAlign: "center", verticalAlign: "middle" }, content: [
        paragraph("Centered heading"),
        tasks,
        { type: "codeBlock", content: [{ type: "text", text: 'status = "demo"' }] },
      ],
    }] }] }] });
  });
  const cell = body.locator("td");
  for (const [text, activeName] of [["left", "靠左对齐"], ["center", "居中对齐"], ["right", "靠右对齐"]]) {
    await cell.locator('li p').filter({ hasText: text! }).click();
    for (const name of ["靠左对齐", "居中对齐", "靠右对齐"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", String(name === activeName));
    }
  }
  await cell.locator('li p').filter({ hasText: "right" }).click();
  await page.getByRole("button", { name: "居中对齐", exact: true }).click();
  await expect(page.getByRole("button", { name: "居中对齐", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "靠右对齐", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "靠右对齐", exact: true }).click();
  await expect(page.getByRole("button", { name: "居中对齐", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "靠右对齐", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const theme of ["dark", "light"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect(cell).toHaveCSS("text-align", "center");
    await expect(cell.locator(":scope > p")).toHaveCSS("text-align", "center");
    await expect(cell.locator("pre")).toHaveCSS("text-align", "left");
    for (const item of await body.locator('ul[data-type="taskList"] > li').all()) {
      const measurements = await item.evaluate(li => {
        const checkbox = li.querySelector("input")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(li.querySelector("p")!);
        const text = range.getBoundingClientRect(), row = li.getBoundingClientRect();
        const group = { left: checkbox.left, right: li.querySelector("li > div")!.getBoundingClientRect().right };
        return { gap: text.left - checkbox.right, left: group.left - row.left, right: row.right - group.right, center: (group.left + group.right - row.left - row.right) / 2, align: li.querySelector("p")!.style.textAlign };
      });
      expect(measurements.gap).toBeGreaterThanOrEqual(0);
      expect(measurements.gap).toBeLessThanOrEqual(12);
      const offset = measurements.align === "left" ? measurements.left : measurements.align === "right" ? measurements.right : measurements.center;
      expect(Math.abs(offset)).toBeLessThanOrEqual(1);
    }
  }
});

test("inline assets print without decoding separators and pasted image URLs stay private", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const body = page.locator(".prose-editor");
  await page.locator('.file-tool input').setInputFiles({
    name: "inline.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  const image = body.locator("img[data-attachment-id]");
  await expect(image).toBeVisible();
  const id = await image.getAttribute("data-attachment-id");
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await expect(page.locator('[aria-label="上传文件附件"] input')).toHaveAttribute("accept", /\.yaml/);
  await page.locator('[aria-label="上传文件附件"] input').setInputFiles({ name: "inline.txt", mimeType: "text/plain", buffer: Buffer.from("preview") });
  await expect(body.locator(".inline-file")).toBeVisible();
  // Include both supported image shapes in the same document.
  await body.evaluate((el, attachmentId) => {
    const editor = (el as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "image", attrs: { attachmentId, src: "/api/attachments/" + attachmentId, alt: "block" } });
  }, id);
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printed = "true"; }; });
  await page.getByRole("button", { name: "笔记更多", exact: true }).click();
  await page.getByRole("button", { name: "打印 / 保存为 PDF", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-printed", "true");
  let externalRequests = 0;
  await page.route("https://external.invalid/**", route => { externalRequests++; return route.abort(); });
  const before = await image.count();
  await body.evaluate((el, attachmentId) => {
    const editor = (el as HTMLElement & { editor: Editor }).editor;
    editor.commands.focus("end");
    const data = new DataTransfer();
    data.setData("text/html", '<img data-inline-image data-attachment-id="' + attachmentId + '" src="https://external.invalid/tracker.png">');
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, id);
  await expect(page.getByText(/外部图片地址不会被自动下载/)).toBeVisible();
  await expect(image).toHaveCount(before);
  expect(externalRequests).toBe(0);
});

test("search reveals folded code without persisting its temporary expansion", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const body = page.locator(".prose-editor");
  await body.evaluate(el => {
    const editor = (el as HTMLElement & { editor: Editor }).editor;
    editor.commands.setContent({ type: "doc", content: [{ type: "codeBlock", attrs: { collapsed: true }, content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => i === 30 ? "folded-target" : "line " + i).join("\n") }] }] });
  });
  await expect(body.locator("pre")).toHaveClass(/code-collapsed/);
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByPlaceholder("在笔记中查找").fill("folded-target");
  await expect(body.locator("pre")).not.toHaveClass(/code-collapsed/);
  expect(await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.state.doc.firstChild?.attrs.collapsed)).toBe(true);
});
