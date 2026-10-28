import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("foreground activity renews once while idle reload does not", async ({ page }) => {
  let renewals = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/session/activity") renewals++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const picker = page.getByLabel("选择笔记本", { exact: true });
  await expect(picker).toBeVisible();
  await page.reload();
  await expect(picker).toBeVisible();
  expect(renewals).toBe(0);
  // A real click followed by a successful business request qualifies.
  await picker.click();
  await picker.selectOption("all");
  await expect.poll(() => renewals).toBe(1);
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await expect(page.locator(".prose-editor")).toBeVisible();
  expect(renewals).toBe(1);
});
