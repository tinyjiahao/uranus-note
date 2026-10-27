import { test, expect, openWorkspaceMenu } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test("form controls follow the application theme instead of the system theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("uranus.theme", "light"));
  await page.goto("/login");
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveCSS("color-scheme", "light");
  await expect(page.getByLabel("显示密码", { exact: true })).toHaveCSS("color-scheme", "light");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await openWorkspaceMenu(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("账号与安全", { exact: true }).click();
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    const background = theme === "light" ? "rgb(247, 246, 242)" : "rgb(23, 23, 20)";
    for (const label of ["远程同步间隔（秒）", "当前密码", "主题"]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveCSS("background-color", background);
      await expect(page.getByLabel(label, { exact: true })).toHaveCSS("color-scheme", theme);
    }
    await expect(page.getByLabel("显示密码", { exact: true })).toHaveCSS("color-scheme", theme);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.locator(".settings-drawer").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("workspace actions live in top-right menu with and without a selected note", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".sidebar-footer, .settings-launcher")).toHaveCount(0);
  await openWorkspaceMenu(page);
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
  const previous = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", previous ?? "");
  await expect(page.getByRole("button", { name: "切换主题", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", previous!);
  await page.keyboard.press("Escape");
  await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
  await openWorkspaceMenu(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("布局", { exact: true })).toBeVisible();
  await page.getByLabel("布局", { exact: true }).selectOption("focus");
  await page.getByLabel("关闭设置").click();
  await expect(page.getByRole("button", { name: "笔记更多", exact: true })).toBeFocused();
  await openWorkspaceMenu(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "笔记更多", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await openWorkspaceMenu(page);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换主题", exact: true })).toBeFocused();
  const rows = await page.getByRole("dialog").locator(".object-popup-content > button, .workspace-menu-actions > button").evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left };
  }));
  expect(rows.length).toBeGreaterThan(3);
  for (const row of rows) expect(row).toEqual(rows[0]);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
});
