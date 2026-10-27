import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("files upload inside header and body cells and survive cross-note table paste", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const body = page.locator(".prose-editor");
  await page.getByRole("button", { name: "表格", exact: true }).click();
  await page.getByRole("button", { name: "2 行 2 列", exact: true }).click();
  for (const selector of ["th", "td"]) {
    await body.locator(selector).first().click();
    await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
    const input = page.locator('[aria-label="上传文件附件"] input');
    await expect(input).toBeEnabled();
    await input.setInputFiles({ name: `${selector}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n") });
    await expect(body.locator(`${selector} .file-attachment`)).toContainText(`${selector}.pdf`);
  }
  await body.getByRole("button", { name: "附件操作：td.pdf" }).click();
  await page.getByRole("button", { name: "卡片样式" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(body.locator("td .file-attachment--card")).toContainText("td.pdf");
  const source = await body.evaluate(element => {
    const editor = (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor;
    return { html: `<div data-pm-slice='0 0 []'>${editor.getHTML()}</div>` };
  });
  const originalIds = await body.evaluate(element => {
    const ids: string[] = [];
    (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.state.doc.descendants(node => { if (node.type.name === "fileAttachment") ids.push(node.attrs.attachmentId); });
    return ids;
  });
  await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(body.locator("table")).toHaveCount(0);
  await body.evaluate((element, html) => {
    const data = new DataTransfer(); data.setData("text/html", html);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, source.html);
  await expect(body.locator(".file-attachment")).toHaveCount(2);
  await expect(body.locator("td .file-attachment--card")).toContainText("td.pdf");
  const newIds = await body.evaluate(element => {
    const ids: string[] = [];
    (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.state.doc.descendants(node => { if (node.type.name === "fileAttachment") ids.push(node.attrs.attachmentId); });
    return ids;
  });
  expect(newIds.every(id => !originalIds.includes(id))).toBe(true);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(body.locator(".file-attachment")).toHaveCount(2);
});

test("file display defaults to compact and card selection persists", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.locator('[aria-label="上传文件附件"] input').setInputFiles({ name: "display.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n") });
  const file = page.locator(".file-attachment");
  await expect(file).toHaveClass(/file-attachment--compact/);
  await expect(file.locator("small")).toHaveCount(0);
  let downloads = 0;
  page.on("download", () => { downloads++; });
  await file.getByRole("button", { name: "附件操作：display.pdf" }).click();
  const actions = page.getByRole("dialog", { name: "附件操作", exact: true });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "紧凑样式" })).toHaveAttribute("aria-pressed", "true");
  await actions.getByRole("button", { name: "卡片样式" }).click();
  await expect(file).toHaveClass(/file-attachment--card/);
  const cardWidth = await file.evaluate(element => element.getBoundingClientRect().width);
  expect(cardWidth).toBeLessThanOrEqual(420);
  expect(cardWidth).toBeLessThan(await page.locator(".prose-editor").evaluate(element => element.clientWidth));
  const constrained = await file.evaluate(element => {
    const editor = element.closest<HTMLElement>(".prose-editor")!;
    const name = element.querySelector("strong")!;
    const originalWidth = editor.style.width, originalName = name.textContent;
    editor.style.width = "240px";
    name.textContent = "很长的附件文件名".repeat(20) + ".pdf";
    const result = { width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth, truncated: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, whiteSpace: getComputedStyle(name).whiteSpace };
    editor.style.width = originalWidth; name.textContent = originalName;
    return result;
  });
  expect(constrained.width).toBeLessThanOrEqual(240);
  expect(constrained.overflow).toBe(false);
  expect(constrained.truncated).toBe(true);
  expect(constrained.ellipsis).toBe("ellipsis");
  expect(constrained.whiteSpace).toBe("nowrap");
  await expect(file.locator("strong")).toHaveAttribute("title", "display.pdf");
  expect(downloads).toBe(0);
  await expect(file.locator("small")).toContainText("KB");
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(file).toHaveClass(/file-attachment--card/);
  await file.getByRole("button", { name: "附件操作：display.pdf" }).click();
  await actions.getByRole("button", { name: "紧凑样式" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(file).toHaveClass(/file-attachment--compact/);
  await file.getByRole("button", { name: "附件操作：display.pdf" }).click();
  await expect(actions.locator("a[data-file-download]")).toHaveAttribute("download", "display.pdf");
  expect(downloads).toBe(0);
  const download = page.waitForEvent("download");
  await actions.getByRole("link", { name: "下载附件" }).click();
  expect((await download).suggestedFilename()).toBe("display.pdf");
  expect(downloads).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "只读模式", exact: true }).click();
  await file.getByRole("button", { name: "附件操作：display.pdf" }).click();
  await expect(actions.getByRole("link", { name: "下载附件" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "卡片样式" })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "紧凑样式" })).toHaveCount(0);
});

test("an editor retaining the old attachment schema reports that a refresh is needed", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.locator('[aria-label="上传文件附件"] input').setInputFiles({ name: "legacy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n") });
  await page.getByRole("button", { name: "附件操作：legacy.pdf" }).click();
  await page.locator(".prose-editor").evaluate(element => {
    const editor = (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor;
    // Simulate the node shape retained by a pre-display editor after a UI hot update.
    editor.state.doc.descendants(node => {
      if (node.type.name === "fileAttachment") Reflect.deleteProperty(node.attrs, "display");
    });
  });
  await page.getByRole("button", { name: "卡片样式" }).click();
  await expect(page.getByText("编辑器尚未加载附件样式更新，请先保存笔记，再刷新页面后切换。", { exact: true })).toBeVisible();
});
