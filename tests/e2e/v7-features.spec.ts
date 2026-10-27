import { test, expect, type Page } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
import type { Editor } from "@tiptap/core";
test.use({ trace: "off" });
async function open(page: Page) {
  await page.setViewportSize({ width: 1800, height: 1000 }); await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
}
async function setBody(page: Page, content: unknown) {
  await page.locator(".prose-editor").evaluate((element, content) => { const editor = (element as HTMLElement & { editor: Editor }).editor; editor.commands.setContent(content as never); editor.commands.focus("end"); }, content);
}
test("label popup, file upload, note link, outline and exports survive saving", async ({ page }) => {
  await open(page); const body = page.locator(".prose-editor"), title = page.getByLabel("笔记标题", { exact: true });
  await title.fill("V7 feature fixture"); await body.fill("正文 ");
  await page.keyboard.press("End"); await page.getByRole("button", { name: "更多格式与插入", exact: true }).click(); await page.getByRole("button", { name: "插入标签", exact: true }).click();
  const palette = page.getByRole("group", { name: "标签颜色", exact: true });
  await expect(palette.getByRole("button")).toHaveCount(10);
  await expect(palette).toHaveText("");
  await palette.getByRole("button", { name: "绿色", exact: true }).click();
  await expect(palette.getByRole("button", { name: "绿色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("标签文字", { exact: true }).fill("重要标签"); await page.getByRole("button", { name: "确认标签" }).click();
  await expect(body.locator(".label-chip")).toHaveText("重要标签");
  await expect(body.locator(".label-chip")).toHaveAttribute("data-color", "green");
  await body.locator(".label-chip").click(); await page.getByLabel("标签文字").fill("已修改标签"); await page.getByRole("button", { name: "确认标签" }).click();
  await expect(body.locator(".label-chip")).toHaveText("已修改标签");
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click(); await page.getByRole("button", { name: "插入标签", exact: true }).click(); await page.getByLabel("标签文字").press("Escape"); await expect(body).toBeFocused();
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.locator('[aria-label="上传文件附件"] input').setInputFiles({ name: "fixture.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nfixture") });
  await expect(body.locator(".file-attachment")).toContainText("fixture.pdf");
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload(); await expect(body.locator(".label-chip")).toHaveText("已修改标签"); await expect(body.locator(".file-attachment")).toContainText("fixture.pdf");
  await expect(body.locator(".label-chip")).toHaveAttribute("data-color", "green");
  await body.locator("p").first().click(); await page.keyboard.press("End");
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click(); await page.getByRole("button", { name: "插入笔记链接", exact: true }).click(); await page.getByLabel("搜索笔记标题").fill("V7 feature fixture");
  await page.getByRole("dialog", { name: "插入笔记链接" }).getByRole("button", { name: "V7 feature fixture", exact: true }).first().click();
  await expect(body.locator(".note-link")).toContainText("V7 feature fixture");
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.getByRole("button", { name: "笔记更多", exact: true }).click();
  const mdDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "导出 Markdown", exact: true }).click(); expect((await mdDownload).suggestedFilename()).toMatch(/\.md$/);
  await page.getByRole("button", { name: "笔记更多", exact: true }).click(); await page.getByRole("button", { name: "导出 ZIP（含附件）", exact: true }).click();
  const zipDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "开始导出", exact: true }).click();
  const downloaded = await zipDownload; expect(downloaded.suggestedFilename()).toMatch(/\.zip$/); await downloaded.saveAs("test-results/v7-fixture.zip");
  await page.getByRole("dialog", { name: "导出 ZIP（含附件）" }).getByRole("button", { name: "关闭" }).click();
  await setBody(page, { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "正文小节" }] }, { type: "paragraph", content: [{ type: "text", text: "段落" }] }] });
  await page.getByRole("button", { name: "笔记大纲", exact: true }).click(); await page.getByRole("button", { name: "正文小节", exact: true }).click();
  await expect(body).toBeFocused();
  expect(await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.state.selection.$from.parent.type.name)).toBe("heading");
  await page.emulateMedia({ media: "print" }); await expect(page.locator(".format-toolbar")).toBeHidden(); await expect(page.locator(".print-note-title")).toBeVisible();
  await page.screenshot({ path: "test-results/v7-print.png", fullPage: true });
});
test("keyboard input rules, nested task/list Tab and title focus fallback", async ({ page }) => {
  await open(page); const body = page.locator(".prose-editor"), title = page.getByLabel("笔记标题", { exact: true });
  await title.fill("标题"); await title.press("Enter"); await expect(body).toBeFocused();
  await body.fill("保留正文"); await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.commands.focus("start"));
  expect(await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.state.selection.from)).toBe(1);
  await page.keyboard.press("Backspace"); await expect(title).toBeFocused(); await expect(body).toHaveText("保留正文");
  for (const prefix of ["[ ] ", "[x] "]) {
    await setBody(page, { type: "doc", content: [{ type: "paragraph" }] }); await page.keyboard.type(prefix + "first");
    await expect(body.locator('ul[data-type="taskList"]')).toHaveCount(1);
    await page.keyboard.press("Enter"); await page.keyboard.type("second"); await page.keyboard.press("Tab"); await expect(body.locator("li li")).toHaveCount(1);
    await page.keyboard.press("Shift+Tab"); await expect(body.locator("li li")).toHaveCount(0);
  }
  await setBody(page, { type: "doc", content: [{ type: "paragraph" }] }); await page.keyboard.type("==highlight=="); await expect(body.locator("mark")).toHaveText("highlight");
  await setBody(page, { type: "doc", content: [{ type: "paragraph" }] }); await page.keyboard.type("- first"); await page.keyboard.press("Enter"); await page.keyboard.type("second"); await page.keyboard.press("Tab"); await expect(body.locator("li li")).toHaveCount(1); await page.keyboard.press("Shift+Tab"); await expect(body.locator("li li")).toHaveCount(0);
  await setBody(page, { type: "doc", content: [{ type: "codeBlock" }] }); await page.keyboard.press("Tab"); await expect(body.locator("code")).toHaveText("  "); await page.keyboard.press("Shift+Tab"); await expect(body.locator("code")).toHaveText("");
  await setBody(page, { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] }] });
  await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.commands.focus("start")); await page.keyboard.press("Backspace"); await expect(body).toBeFocused(); await expect(body.locator("h2")).toHaveCount(0);
  await page.keyboard.press("Backspace"); await expect(title).toBeFocused();
});

test("table keyboard rules and cross-note file paste retain valid references", async ({ page }) => {
  await open(page); const body = page.locator(".prose-editor");
  await page.getByRole("button", { name: "表格", exact: true }).click(); await page.getByRole("button", { name: "2 行 2 列", exact: true }).click(); await body.locator("td").first().click();
  await page.keyboard.type("[ ] first"); await page.keyboard.press("Enter"); await page.keyboard.type("second"); await page.keyboard.press("Tab");
  await expect(body.locator("td li li")).toHaveCount(1); await page.keyboard.press("Shift+Tab"); await expect(body.locator("td li li")).toHaveCount(0);
  await body.locator("td").nth(1).click(); await page.keyboard.type("==cell=="); await expect(body.locator("td mark")).toHaveText("cell");
  await setBody(page, { type: "doc", content: [{ type: "paragraph" }] });
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.locator('[aria-label="上传文件附件"] input').setInputFiles({ name: "copy.txt", mimeType: "text/plain", buffer: Buffer.from("copy fixture") });
  await expect(body.locator(".file-attachment")).toBeVisible();
  const source = await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getJSON().content?.find(node => node.type === "fileAttachment")?.attrs?.attachmentId);
  const html = await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getHTML());
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.getByTitle("新建笔记 (⌘N)").click(); await expect(body.locator(".file-attachment")).toHaveCount(0);
  await body.evaluate((el, html) => { const data = new DataTransfer(); data.setData("text/html", html); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); }, html);
  await expect(body.locator(".file-attachment")).toContainText("copy.txt");
  expect(await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.getJSON().content?.find(node => node.type === "fileAttachment")?.attrs?.attachmentId)).not.toBe(source);
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器"); await page.reload(); await expect(body.locator(".file-attachment")).toContainText("copy.txt");
});

test("serialized labels validate on paste, IME Enter does not submit, missing note links degrade", async ({ page }) => {
  await open(page); const body = page.locator(".prose-editor"); await body.click();
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click(); await page.getByRole("button", { name: "插入标签", exact: true }).click(); const input = page.getByLabel("标签文字", { exact: true }); await input.fill("组合输入");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true }); await expect(page.getByRole("dialog", { name: "插入标签" })).toBeVisible(); await expect(body.locator(".label-chip")).toHaveCount(0);
  await input.press("Enter"); await expect(body.locator(".label-chip")).toHaveText("组合输入");
  await setBody(page, { type: "doc", content: [{ type: "paragraph" }] });
  const paste = async (html: string) => body.evaluate((el, html) => { const data = new DataTransfer(); data.setData("text/html", html); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); }, html);
  await paste('<p><span data-uranus-label="1" data-text="粘贴标签" data-color="green">粘贴标签</span></p>'); await expect(body.locator(".label-chip")).toHaveText("粘贴标签");
  await paste('<p><span data-uranus-label="1" data-text="外部文字" data-color="invalid">外部文字</span></p>'); await expect(body.locator(".label-chip")).toHaveCount(1); await expect(body).toContainText("外部文字");
  await setBody(page, { type: "doc", content: [{ type: "paragraph", content: [{ type: "noteLink", attrs: { noteId: 9007199254740000, title: "不可用目标快照" } }] }] });
  await expect(body.locator(".note-link-missing")).toContainText("不可用目标快照");
  const before = page.url(); await expect(body.locator("[data-note-link]")).toBeDisabled(); await body.locator("[data-note-link]").dispatchEvent("click"); await expect(page).toHaveURL(before);
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.commands.focus("start"));
  await body.dispatchEvent("keydown", { key: "Backspace", isComposing: true }); await expect(body).toBeFocused();
});

test("lazy images are cached and all loaded for clean light printing and ZIP", async ({ page, context, baseURL }) => {
  await open(page); const body = page.locator(".prose-editor"); await page.getByLabel("笔记标题", { exact: true }).fill("V7 多图打印");
  const noteId = Number(page.url().split("/").at(-1));
  const session = await (await page.request.get("/api/session")).json();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const uploaded = await page.request.post("/api/attachments", { headers: { Origin: new URL(baseURL!).origin, "X-CSRF-Token": session.csrfToken }, multipart: { note_id: String(noteId), operation_id: await page.evaluate(() => { const b=crypto.getRandomValues(new Uint8Array(16)); let t=BigInt(Date.now()); for(let i=5;i>=0;i--) {b[i]=Number(t&255n);t>>=8n;} b[6]=(b[6]!&15)|112;b[8]=(b[8]!&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,"0")).join("");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }), file: { name: "print.png", mimeType: "image/png", buffer: png } } });
  expect(uploaded.status()).toBe(201); const asset = await uploaded.json();
  const image = { type: "image", attrs: { attachmentId: asset.id, src: asset.url, alt: "print.png" } };
  await body.evaluate((el, content) => { const editor = (el as HTMLElement & { editor: Editor }).editor; editor.commands.setContent(content); editor.commands.focus("start"); }, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "打印正文" }] }, ...Array.from({ length: 120 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `长段落 ${i}` }] })), image] });
  await body.evaluate(el => (el as HTMLElement & { editor: Editor }).editor.commands.focus("start"));
  await expect(body.locator("img")).toHaveAttribute("loading", "lazy"); await expect(body.locator("img")).toHaveAttribute("decoding", "async");
  expect(await body.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(0);
  await page.evaluate(() => { window.print = () => { (window as unknown as { printedReady: boolean }).printedReady = [...document.querySelectorAll<HTMLImageElement>(".prose-editor img")].every(image => image.complete && image.naturalWidth > 0 && image.loading === "eager"); }; });
  await page.getByRole("button", { name: "笔记更多", exact: true }).click(); await page.getByRole("button", { name: "打印 / 保存为 PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printedReady: boolean }).printedReady)).toBe(true);
  await expect(body.locator("img")).toHaveAttribute("loading", "lazy");
  await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  const cdp = await context.newCDPSession(page); await cdp.send("Network.enable"); let hits = 0; const images = new Set<string>();
  cdp.on("Network.requestWillBeSent", event => { if (event.request.url.endsWith(asset.url)) images.add(event.requestId); });
  cdp.on("Network.requestServedFromCache", event => { if (images.has(event.requestId)) hits++; });
  const url = page.url(); await page.getByTitle("新建笔记 (⌘N)").click(); await page.goto(url); await body.locator("img").scrollIntoViewIfNeeded();
  await expect.poll(() => body.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1); expect(hits).toBeGreaterThan(0);
  await page.getByRole("button", { name: "笔记更多", exact: true }).click(); await page.getByRole("button", { name: "导出 ZIP（含附件）", exact: true }).click();
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "开始导出" }).click(); await (await download).saveAs("test-results/v7-images.zip");
  await page.getByRole("dialog", { name: "导出 ZIP（含附件）" }).getByRole("button", { name: "关闭菜单" }).click();
  await page.emulateMedia({ media: "print" }); await expect(page.locator(".sidebar")).toBeHidden(); await expect(body).toHaveCSS("color", "rgb(17, 17, 17)");
  await page.pdf({ path: "test-results/v7-long-print.pdf", format: "A4" });
});

test("ZIP export reports missing files and cancellation without downloading partial archives", async ({ page }) => {
  await open(page); await page.getByLabel("笔记标题", { exact: true }).fill("ZIP failure fixture");
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.locator('[aria-label="上传文件附件"] input').setInputFiles({ name: "zip.txt", mimeType: "text/plain", buffer: Buffer.from("zip fixture") });
  await expect(page.locator(".file-attachment")).toBeVisible(); await page.keyboard.press("ControlOrMeta+s"); await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  const fileUrl = await page.locator(".prose-editor").evaluate(el => "/api/attachments/" + (el as HTMLElement & { editor: Editor }).editor.getJSON().content?.find(node => node.type === "fileAttachment")?.attrs?.attachmentId);
  await page.route(`**${fileUrl}`, route => route.fulfill({ status: 503, json: { error: { code: "ATTACHMENT_OBJECT_MISSING" } } }));
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "笔记更多", exact: true }).click(); await page.getByRole("button", { name: "导出 ZIP（含附件）", exact: true }).click();
  await page.getByRole("button", { name: "开始导出" }).click(); await expect(page.getByRole("dialog").getByRole("status")).toContainText("未生成不完整的 ZIP"); expect(downloads).toBe(0);
  await page.unroute(`**${fileUrl}`);
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${fileUrl}`, async route => { await gate; await route.abort().catch(() => undefined); });
  await page.getByRole("button", { name: "开始导出" }).click(); await page.getByRole("button", { name: "取消导出", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("已取消导出"); release(); expect(downloads).toBe(0);
});
