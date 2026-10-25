import { expect, test } from "./fixtures";
import { testApiToken } from "./credentials";

test("image upload uses multipart and remains visible after saving and reloading", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const response = page.waitForResponse(r => r.url().endsWith("/api/attachments") && r.request().method() === "POST");
  await page.locator('.file-tool input[type="file"]').setInputFiles({
    name: "upload-regression.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  const uploaded = await response;
  expect(uploaded.request().headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(uploaded.status()).toBe(201);
  const picture = page.locator(".prose-editor img");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.reload();
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
});

test("upload failure exposes retry without inserting a broken image", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
  await page.route("**/api/attachments", route => route.abort("failed"));
  await page.locator('.file-tool input[type="file"]').setInputFiles({
    name: "retry.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByRole("button", { name: "重试上传" })).toBeVisible();
  await expect(page.locator(".prose-editor img")).toHaveCount(0);
  await page.unroute("**/api/attachments"); await page.getByRole("button", { name: "重试上传" }).click();
  await expect(page.locator(".prose-editor img")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试上传" })).toHaveCount(0);
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
});
