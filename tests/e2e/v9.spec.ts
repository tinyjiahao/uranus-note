import { expect, test, type Page } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
import type { Editor } from "@tiptap/core";

test.describe.configure({ timeout: 125_000 });

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible({ timeout: 75_000 });
  await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
}

test("find/replace excludes the title, is undoable, guards IME, and readonly only finds", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await page.getByRole("textbox", { name: "笔记标题", exact: true }).fill("foo title");
  await editor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
    type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "foo foo" }] }],
  }));
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByPlaceholder("在笔记中查找"), replacement = page.getByPlaceholder("替换为");
  await find.fill("title");
  await expect(page.getByRole("button", { name: "全部替换", exact: true })).toBeDisabled();
  await find.fill("foo");
  await expect(page.locator(".find-bar")).toContainText("标题 · 1/3");
  await expect(page.getByRole("button", { name: "替换", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "下一个匹配" }).click();
  await replacement.fill("bar");
  await page.getByRole("button", { name: "替换", exact: true }).click();
  await expect(editor).toContainText("bar foo");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor).toContainText("foo foo");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(editor).toContainText("bar foo");

  const beforeIme = await editor.textContent();
  await replacement.fill("IME");
  await replacement.dispatchEvent("compositionstart");
  await replacement.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await replacement.dispatchEvent("compositionend");
  expect(await editor.textContent()).toBe(beforeIme);
  await replacement.fill("baz");
  await page.getByRole("button", { name: "全部替换", exact: true }).click();
  await expect(editor).toContainText("bar baz");
  const editorNotice = page.locator(".editor-notice");
  await expect(editorNotice).toContainText("已替换 1 处");
  await editorNotice.getByRole("button", { name: "关闭提示" }).click();
  await expect(editorNotice).toHaveClass(/is-leaving/);
  await expect(editorNotice).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor).toContainText("bar foo");
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue("foo title");

  await page.getByRole("button", { name: "完成", exact: true }).click();
  await editor.click(); await page.keyboard.press("End");
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.getByRole("button", { name: "插入日期", exact: true }).click();
  const now = new Date(), expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await expect(editor).toContainText(expectedDate);
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.getByRole("button", { name: "插入日期时间", exact: true }).click();
  await expect(editor).toContainText(new RegExp(`${expectedDate} \\d{2}:\\d{2}`));
  await page.getByRole("button", { name: "切换到只读模式", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByPlaceholder("替换为")).toHaveCount(0);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.getByRole("button", { name: "笔记更多", exact: true }).click();
  const noteMenu = page.getByRole("dialog", { name: "foo title" });
  await expect(noteMenu.locator("header strong")).toHaveText("");
  await expect(noteMenu.locator(".object-popup-content > button").first()).toHaveText("置顶");
});

test("code highlighting, formatting, language Popup, copy-line, and slash commands coexist", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  const editor = page.locator(".prose-editor");
  await editor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.setContent({
    type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: '{"ok":true}' }] }],
  }));
  await expect(editor.locator(".hljs-attr")).toBeVisible();
  await page.getByRole("button", { name: "格式化", exact: true }).click();
  await expect(editor.locator("pre")).toContainText('  "ok": true');
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(() => editor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.textContent)).toBe('{"ok":true}');
  await page.getByRole("button", { name: "代码语言：文本", exact: true }).click();
  const language = page.getByRole("dialog", { name: "选择代码语言" });
  await expect(language).toBeVisible();
  await language.getByRole("button", { name: "TypeScript", exact: true }).click();
  expect(await editor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.firstChild?.attrs.language)).toBe("typescript");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(page.getByRole("button", { name: "代码语言：TypeScript", exact: true })).toBeVisible();

  await editor.evaluate(element => {
    const instance = (element as HTMLElement & { editor: Editor }).editor;
    instance.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "copy me" }] }] });
    instance.commands.setTextSelection(4);
    instance.view.focus();
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy me\n");
  await editor.evaluate(element => {
    const instance = (element as HTMLElement & { editor: Editor }).editor;
    instance.commands.setContent({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "one\ntwo" }] }] });
    instance.commands.setTextSelection(7); instance.view.focus();
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("two\n");

  await editor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] }));
  await editor.click(); await page.keyboard.type("/");
  await expect(page.getByRole("dialog", { name: "斜杠命令" })).toBeVisible();
  const slashMenu = page.getByRole("dialog", { name: "斜杠命令" });
  const initialMenuBox = (await slashMenu.boundingBox())!;
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press("ArrowDown");
    const box = (await slashMenu.boundingBox())!;
    expect(Math.abs(box.y - initialMenuBox.y)).toBeLessThan(2);
    expect(Math.abs(box.x - initialMenuBox.x)).toBeLessThan(2);
    await expect.poll(() => slashMenu.evaluate(menu => {
      const selected = menu.querySelector(".active")!.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      return selected.top >= bounds.top && selected.bottom <= bounds.bottom;
    })).toBe(true);
  }
  await page.keyboard.type("h1");
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu.getByRole("button")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText("/h1");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.keyboard.type("Slash heading");
  await expect(editor.locator("h1")).toHaveText("Slash heading");
  await page.keyboard.press("Enter"); await page.keyboard.type("/h2");
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("/h2");
});

test("plain-text Markdown validates, preserves HTML paste, uploads data images serially, and supplies a thumbnail", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await editor.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "## Markdown 标题\n\n**粗体和 *斜体***\n\n| A | B |\n|---|---|\n| only |\n\n![图](images/a.png)");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator("h2")).toHaveText("Markdown 标题");
  await expect(editor.locator("strong em")).toHaveText("斜体");
  await expect(editor.locator("tr").nth(1).locator("td,th")).toHaveCount(2);
  await expect(editor).toContainText("[图](images/a.png)");
  await expect(editor.locator("img")).toHaveCount(0);

  await editor.click(); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await editor.evaluate(element => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "# 不应转换\n第二行"); transfer.setData("text/html", "<p># 不应转换</p><p>第二行</p>");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator("h1")).toHaveCount(0);
  await expect(editor).toContainText("# 不应转换");

  await editor.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] }));
  let uploadCount = 0, releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route("**/api/attachments", async route => {
    uploadCount++;
    if (uploadCount === 1) await gate;
    await route.continue();
  });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await editor.evaluate((element, source) => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", `# 图片\n\n![一](data:image/png;base64,${source}) ![二](data:image/png;base64,${source})`);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png);
  await expect(editor).toContainText("图片上传中");
  await expect.poll(() => uploadCount).toBe(1);
  await page.waitForTimeout(200); expect(uploadCount).toBe(1);
  releaseFirst();
  await expect(editor.locator("img[data-attachment-id]")).toHaveCount(2, { timeout: 20_000 });
  expect(uploadCount).toBe(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await expect(page.locator(".note-row.active .note-thumb")).toBeVisible();
});

test("popup geometry settles after motion and reduced-motion removes visible delay", async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 800 });
  const popup = page.getByRole("dialog", { name: "更多格式与插入" });
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.waitForTimeout(200);
  const box = (await popup.boundingBox())!;
  expect(box.x).toBe(0); expect(box.y + box.height).toBeCloseTo(800, 0);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await expect(popup).toBeVisible();
  expect(Number.parseFloat(await popup.evaluate(element => getComputedStyle(element).animationDuration))).toBeLessThanOrEqual(0.00001);
});
