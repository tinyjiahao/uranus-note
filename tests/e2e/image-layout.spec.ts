import { expect, test, type Page } from "@playwright/test";
import { testApiToken } from "./credentials";

async function upload(page: Page, width = 120) {
  const data = await page.evaluate(width => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = 80;
    const context = canvas.getContext("2d")!; context.fillStyle = "#e0b020"; context.fillRect(0, 0, width, 80);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, width);
  await page.locator('.file-tool input[type="file"]').setInputFiles({ name: "layout.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
}
test("images align independently in body and table cells and persist in readonly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/login"); await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const editor = page.locator(".prose-editor");
  await editor.fill("图片布局测试"); await editor.press("Enter"); await upload(page);
  const bodyImage = editor.locator("figure").first();
  await bodyImage.locator("img").click();
  for (const [name, value] of [["靠左对齐", "left"], ["居中对齐", "center"], ["靠右对齐", "right"]] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(bodyImage).toHaveAttribute("data-image-align", value!);
    const offset = await bodyImage.evaluate(el => { const a=el.getBoundingClientRect(); const b=el.querySelector("img")!.getBoundingClientRect(); return { left:b.left-a.left, right:a.right-b.right }; });
    if (value === "left") expect(offset.left).toBeLessThan(2);
    if (value === "right") expect(offset.right).toBeLessThan(2);
    if (value === "center") expect(Math.abs(offset.left-offset.right)).toBeLessThan(2);
  }
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(bodyImage).toHaveAttribute("data-image-align", "center");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(bodyImage).toHaveAttribute("data-image-align", "right");
  await editor.press("ControlOrMeta+End"); await editor.press("ArrowDown"); await editor.press("Enter");
  await page.getByRole("button", { name: "表格", exact: true }).click();
  await page.getByRole("button", { name: "2 行 2 列", exact: true }).click();
  await editor.locator("th").first().click(); await upload(page, 1200);
  const headerImage = editor.locator("th figure").first();
  await expect(headerImage.locator("img")).toBeVisible();
  await headerImage.locator("img").click();
  await page.getByRole("button", { name: "靠左对齐", exact: true }).click();
  await expect(headerImage).toHaveCSS("text-align", "left");
  expect(await headerImage.evaluate(el => el.querySelector("img")!.getBoundingClientRect().width <= el.closest("th")!.getBoundingClientRect().width)).toBe(true);
  await editor.locator("td").first().click(); await upload(page);
  const cellImage = editor.locator("td figure").first();
  await cellImage.locator("img").click();
  await page.getByRole("button", { name: "居中对齐", exact: true }).click();
  await expect(cellImage).toHaveCSS("text-align", "center");
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(page.getByText("已保存到服务器", { exact: true })).toBeVisible();
  await page.reload();
  await expect(editor.locator("img")).toHaveCount(3);
  await expect(bodyImage).toHaveAttribute("data-image-align", "right");
  await expect(headerImage).toHaveCSS("text-align", "left");
  await expect(cellImage).toHaveCSS("text-align", "center");
  await cellImage.locator("img").click();
  await page.getByRole("button", { name: "只读模式", exact: true }).click();
  for (const name of ["靠左对齐", "居中对齐", "靠右对齐"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  for (const handle of await editor.locator(".image-resize-handle").all()) await expect(handle).toBeHidden();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await cellImage.evaluate(el => el.querySelector("img")!.getBoundingClientRect().width <= el.closest("td")!.getBoundingClientRect().width)).toBe(true);
});
