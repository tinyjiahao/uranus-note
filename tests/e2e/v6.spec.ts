import { openWorkspaceMenu } from "./fixtures";
import { test, expect } from "@playwright/test";
import { testEmail, testPassword } from "./credentials";

test.use({ trace: "off" });

test("login aligns password visibility control and omits disabled registration notice", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { authenticated: false, registrationEnabled: false } }));
  await page.goto("/login");
  await expect(page.getByText("当前实例未开放注册", { exact: true })).toHaveCount(0);
  const row = page.locator(".login-password-visibility");
  const checkbox = row.locator('input[type="checkbox"]');
  await expect(row).toHaveCSS("align-items", "center");
  await expect(checkbox).toHaveCSS("width", "18px");
  await expect(checkbox).toHaveCSS("height", "18px");
  const rowBox = (await row.boundingBox())!;
  const checkboxBox = (await checkbox.boundingBox())!;
  expect(Math.abs(checkboxBox.y + checkboxBox.height / 2 - (rowBox.y + rowBox.height / 2))).toBeLessThan(1);
});

test("v6 local email login, owned notes, account settings and revocable logout", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/login");
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.getByText("访问令牌", { exact: true })).toHaveCount(0);
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "全部笔记", exact: true }).click();
  await expect(page.locator(".note-row").first()).toBeVisible();
  const session = await page.request.get("/api/session");
  const info = await session.json();
  expect(info.authenticated).toBe(true);
  expect(info.user.email.toLowerCase()).toBe(testEmail().toLowerCase());
  const oldCookies = await page.context().cookies();
  const cookie = oldCookies.find(item => item.name === "uranus_session");
  expect(cookie?.httpOnly).toBe(true);
  await page.locator(".note-row").first().click();
  await expect(page.locator(".prose-editor")).toBeVisible();
  await openWorkspaceMenu(page); await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("账号与安全", { exact: true }).click();
  await expect(page.getByText("当前邮箱：" + info.user.email, { exact: true })).toBeVisible();
  const accountForm = page.locator(".account-form");
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["修改邮箱", "修改密码"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      const fields = accountForm.locator('input:not([type="checkbox"])');
      const boxes = await fields.evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }));
      for (let i = 0; i < boxes.length; i++) {
        expect(boxes[i]!.left).toBeCloseTo(boxes[0]!.left, 0);
        expect(boxes[i]!.right).toBeCloseTo(boxes[0]!.right, 0);
        expect(boxes[i]!.right).toBeLessThanOrEqual(width);
        if (i) expect(boxes[i]!.top).toBeGreaterThan(boxes[i - 1]!.bottom);
      }
      await accountForm.getByLabel("显示密码").check();
      await expect(accountForm.getByLabel("当前密码", { exact: true })).toHaveAttribute("type", "text");
      await accountForm.getByLabel("显示密码").uncheck();
      await expect(accountForm.getByLabel("当前密码", { exact: true })).toHaveAttribute("type", "password");
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.screenshot({ path: "test-results/v6-local-workspace.png" });
  await openWorkspaceMenu(page); await page.getByTitle("退出", { exact: true }).click();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  const revoked = await page.request.get("/api/notes", { headers: { Cookie: "uranus_session=" + cookie!.value } });
  expect(revoked.status()).toBe(401);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/v6-local-login.png" });
});
