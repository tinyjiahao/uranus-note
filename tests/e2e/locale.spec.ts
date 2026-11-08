import { expect, test } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("switches English and Chinese without replacing the active note editor", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "界面语言", exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload();
  await page.getByLabel("Email", { exact: true }).fill(testEmail());
  await page.getByLabel("Password", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const body = page.locator(".prose-editor");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Insert table" })).toBeVisible();
  await page.keyboard.press("Escape");
  await body.fill("中英文 content");
  const noteUrl = page.url();
  const editor = await body.elementHandle();
  await page.getByRole("button", { name: "More note actions", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh-CN");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeVisible();
  await expect(body).toHaveText("中英文 content");
  expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
  expect(page.url()).toBe(noteUrl);
});
