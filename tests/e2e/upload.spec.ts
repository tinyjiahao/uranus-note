import { expect, test } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("image upload uses multipart and remains visible after saving and reloading", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const response = page.waitForResponse(r => r.url().endsWith("/api/attachments") && r.request().method() === "POST");
  await page.locator('.file-tool[aria-label="上传图片"] input[type="file"]').setInputFiles({
    name: "upload-regression.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  const uploaded = await response;
  expect(uploaded.request().headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(uploaded.status()).toBe(201);
  const picture = page.locator(".prose-editor img[data-attachment-id]");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.reload();
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
});

test("upload failure exposes retry without inserting a broken image", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
  await page.route("**/api/attachments", route => route.abort("failed"));
  await page.locator('.file-tool[aria-label="上传图片"] input[type="file"]').setInputFiles({
    name: "retry.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByRole("button", { name: "重试上传" })).toBeVisible();
  await expect(page.locator(".prose-editor img[data-attachment-id]")).toHaveCount(0);
  await page.unroute("**/api/attachments"); await page.getByRole("button", { name: "重试上传" }).click();
  await expect(page.locator(".prose-editor img[data-attachment-id]")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试上传" })).toHaveCount(0);
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
});

for (const target of ["body", "table cell"] as const) test(`image-only clipboard pastes into ${target} and persists`, async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByTitle("新建笔记 (⌘N)").click();
  const editor = page.locator(".prose-editor");
  if (target === "table cell") {
    await page.getByRole("button", { name: "表格", exact: true }).click();
    await page.getByRole("button", { name: "2 行 2 列", exact: true }).click();
    await editor.locator("td").first().click();
  } else await editor.click();
  const upload = page.waitForResponse(response => response.url().endsWith("/api/attachments") && response.request().method() === "POST");
  await editor.evaluate(element => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "image-only.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  expect((await upload).status()).toBe(201);
  const picture = target === "table cell" ? editor.locator("td").first().locator("img[data-attachment-id]") : editor.locator("img[data-attachment-id]");
  await expect(picture).toBeVisible();
  await expect(editor.locator("img[data-attachment-id]")).toHaveCount(1);
  await expect(page.getByText(/图片粘贴未完成/)).toHaveCount(0);
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
});

test("clipboard files and copied private images paste without cross-note references", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByTitle("新建笔记 (⌘N)").click();
  const editor = page.locator(".prose-editor"); await editor.click();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const upload = page.waitForResponse(response => response.url().endsWith("/api/attachments") && response.request().method() === "POST");
  await editor.evaluate((element, encoded) => {
    const binary = atob(encoded); const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], "clipboard.png", { type: "image/png" })); transfer.setData("text/plain", "粘贴文字");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png);
  expect((await upload).status()).toBe(201);
  await expect(editor).toContainText("粘贴文字"); await expect(editor.locator("img[data-attachment-id]")).toHaveCount(1);
  const sourceId = await editor.locator("img[data-attachment-id]").getAttribute("data-attachment-id"); expect(sourceId).toBeTruthy();

  await editor.evaluate(element => (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor.commands.focus("end"));
  await editor.evaluate((element, id) => {
    const transfer = new DataTransfer(); transfer.setData("text/html", `<img src="/api/attachments/${id}" data-attachment-id="${id}" alt="copied.png">`);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, sourceId!);
  await expect(editor.locator("img[data-attachment-id]")).toHaveCount(2);
  expect(await editor.locator("img[data-attachment-id]").nth(1).getAttribute("data-attachment-id")).toBe(sourceId);

  await page.getByRole("button", { name: "新建笔记", exact: true }).click(); await expect(editor).toHaveText(""); await editor.click();
  const copied = page.waitForResponse(response => response.url().includes(`/api/attachments/${sourceId}/copy`) && response.request().method() === "POST");
  await editor.evaluate((element, id) => {
    const transfer = new DataTransfer(); transfer.setData("text/html", `<img src="/api/attachments/${id}" data-attachment-id="${id}" alt="copied.png">`);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, sourceId!);
  expect((await copied).status()).toBe(201); await expect(editor.locator("img[data-attachment-id]")).toHaveCount(1);
  expect(await editor.locator("img[data-attachment-id]").getAttribute("data-attachment-id")).not.toBe(sourceId);
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
});
