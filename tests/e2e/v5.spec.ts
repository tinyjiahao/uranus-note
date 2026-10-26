import { expect, test, type Page } from "./fixtures";
import { testApiToken } from "./credentials";

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/login");
  await page.getByLabel("访问令牌").fill(testApiToken());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  await expect(page.locator(".prose-editor")).toBeVisible();
}

for (const kind of ["无序列表", "有序列表", "待办"]) for (const inTable of [false, true]) test(`indent toolbar ${kind} ${inTable ? "cell" : "body"}`, async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  const increase = page.getByRole("button", { name: "增加缩进", exact: true });
  const decrease = page.getByRole("button", { name: "减少缩进", exact: true });
  await editor.click();
  await expect(increase).toBeDisabled();
  await expect(decrease).toBeDisabled();
  if (inTable) {
    await page.getByRole("button", { name: "表格", exact: true }).click();
    await page.getByRole("button", { name: "2 行 2 列", exact: true }).click();
    await editor.locator("td").first().click();
  }
  const scope = inTable ? editor.locator("td").first() : editor;
  await page.getByRole("button", { name: kind, exact: true }).click();
  await page.keyboard.insertText("第一项");
  await expect(increase).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二项");
  await increase.click();
  await expect(scope.locator("li li p")).toHaveText("第二项");
  await decrease.click();
  await expect(scope.locator("li li")).toHaveCount(0);
  await expect(scope.locator("li")).toHaveCount(2);
  await increase.click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(scope.locator("li li")).toHaveCount(0);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(scope.locator("li li p")).toHaveText("第二项");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(scope.locator("li li p")).toHaveText("第二项");
  await scope.locator("li li p").click();
  await page.getByRole("button", { name: "只读模式", exact: true }).click();
  await expect(increase).toBeDisabled();
  await expect(decrease).toBeDisabled();
});

for (const inTable of [false, true]) test(`empty task item accepts clicks and typing ${inTable ? "inside a cell" : "in the body"}`, async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  if (inTable) {
    await page.getByRole("button", { name: "表格", exact: true }).click();
    await page.getByRole("button", { name: "2 行 2 列", exact: true }).click();
    await editor.locator("td").first().click();
  } else await editor.click();
  await page.getByRole("button", { name: "待办", exact: true }).click();
  await page.keyboard.insertText("第一项");
  await page.keyboard.press("Enter");
  const item = editor.locator('ul[data-type="taskList"] > li').last();
  const text = item.locator(":scope > div > p").first();
  const box = (await text.boundingBox())!;
  expect(box.width).toBeGreaterThan(40);
  expect(box.height).toBeGreaterThan(10);
  await page.getByRole("textbox", { name: "笔记标题", exact: true }).focus();
  await text.click({ position: { x: 20, y: box.height / 2 } });
  await expect(editor).toBeFocused();
  expect(await text.evaluate(el => {
    const selection = window.getSelection();
    return !!selection?.isCollapsed && el.contains(selection.anchorNode);
  })).toBe(true);
  await page.keyboard.insertText("新增待办");
  await expect(text).toHaveText("新增待办");
});

test("search arrows relocate a single match inside a long code block", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await editor.click();
  await page.getByRole("button", { name: "代码块", exact: true }).click();
  await page.keyboard.insertText(["唯一搜索目标", ...Array.from({ length: 150 }, (_, i) => `内容行 ${i}`)].join("\n"));
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByPlaceholder("在笔记中查找");
  await input.fill("唯一搜索目标");
  await expect(page.locator(".find-bar")).toContainText("1/1");
  await expect(input).toBeFocused();
  const hit = editor.locator(".search-hit-current");
  const visibleMatch = async () => {
    const match = await hit.boundingBox();
    const viewport = await page.locator(".editor-content").boundingBox();
    return !!match && !!viewport && match.y >= viewport.y && match.y + match.height <= viewport.y + viewport.height;
  };
  await expect.poll(visibleMatch).toBe(true);
  for (const label of ["下一个匹配", "上一个匹配"]) {
    await page.locator(".editor-content").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(visibleMatch).toBe(false);
    await page.getByRole("button", { name: label }).click();
    await expect.poll(visibleMatch).toBe(true);
    await expect(page.locator(".find-bar")).toContainText("1/1");
  }
});

test("link actions popup is compact and keeps edit/remove behavior", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await editor.click();
  await page.getByRole("button", { name: "链接", exact: true }).click();
  const form = page.locator(".link-dialog");
  await form.getByLabel("显示名称").fill("cloudflare");
  await form.getByLabel("链接地址").fill("https://www.cloudflare.com/" + "long-path/".repeat(20));
  await form.getByRole("button", { name: "插入", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "链接操作" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await editor.locator("a").click();
    await expect(popup).toBeVisible();
    expect((await popup.boundingBox())!.width).toBeLessThanOrEqual(240);
    await expect(popup.getByRole("button", { name: "打开链接" })).toHaveCSS("font-size", "13px");
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
  }
  await editor.locator("a").click();
  await popup.getByRole("button", { name: "编辑链接" }).click();
  await expect(form.getByLabel("显示名称")).toHaveValue("cloudflare");
  await form.getByRole("button", { name: "取消", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.locator("a").click();
  await expect(popup).toBeVisible();
  expect((await popup.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect((await popup.getByRole("button", { name: "移除链接" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await popup.getByRole("button", { name: "移除链接" }).click();
  await expect(editor.locator("a")).toHaveCount(0);
  await expect(editor).toContainText("cloudflare");
});

test("v5 shortcut save, cross-mark find, semantic small text and link dialog persist", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await page.getByRole("textbox", { name: "笔记标题", exact: true }).fill("标题定位");
  await page.keyboard.press("Meta+f");
  await page.getByPlaceholder("在笔记中查找").fill("标题定位");
  await expect(page.locator(".find-bar")).toContainText("标题 · 1/1");
  await expect(page.getByPlaceholder("在笔记中查找")).toBeFocused();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await editor.click(); await page.keyboard.insertText("跨节点搜索");
  await page.keyboard.press("Shift+ArrowLeft"); await page.getByRole("button", { name: "加粗", exact: true }).click();
  await page.keyboard.press("Meta+f");
  await page.getByPlaceholder("在笔记中查找").fill("跨节点搜索");
  await expect(page.locator(".find-bar")).toContainText("1/1");
  await expect(page.getByPlaceholder("在笔记中查找")).toBeFocused();
  await page.getByRole("button", { name: "完成", exact: true }).click();

  await editor.click(); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.insertText("小号链接");
  for (let index = 0; index < 4; index++) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByRole("button", { name: "小号文本", exact: true }).click();
  await expect(editor.locator("small")).toContainText("链接");
  await page.getByRole("button", { name: "链接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑链接" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("显示名称").fill("OpenAI");
  await dialog.getByLabel("链接地址").fill("https://openai.com/");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator("a")).toHaveText("OpenAI");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(editor.locator("a[href='https://openai.com/']")).toHaveText("OpenAI");
  await expect(editor.locator("small")).toContainText("OpenAI");
});

test("v5 code block toolbar keeps indentation and exits inside the current container", async ({ page }) => {
  await open(page); const editor = page.locator(".prose-editor"); await editor.click();
  await page.keyboard.insertText("const value = 1"); await page.getByRole("button", { name: "代码块", exact: true }).click();
  await expect(editor.locator("pre")).toContainText("const value = 1");
  await expect(page.getByRole("button", { name: "小号文本", exact: true })).toBeDisabled();
  await page.keyboard.press("End"); await page.keyboard.press("Tab"); await page.keyboard.insertText("// indented");
  await expect(editor.locator("pre")).toContainText("  // indented");
  await page.keyboard.press("Meta+Enter"); await page.keyboard.insertText("代码块后");
  await expect(editor.getByText("代码块后", { exact: true })).toBeVisible();
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload(); await expect(editor.locator("pre")).toContainText("// indented"); await expect(editor).toContainText("代码块后");
});

test("v5 table rich blocks remain rectangular and row numbers are UI-only", async ({ page }) => {
  await open(page);
  const editor = page.locator(".prose-editor");
  await page.getByRole("button", { name: "表格", exact: true }).click();
  await page.getByRole("button", { name: "2 行 2 列", exact: true }).click();
  const first = editor.locator("th").first();
  await first.click(); await page.keyboard.insertText("单元格列表");
  await page.getByRole("button", { name: "无序列表", exact: true }).click();
  await expect(first.locator("ul")).toContainText("单元格列表");
  await editor.locator(".tableWrapper").hover();
  await page.getByRole("button", { name: "表格菜单", exact: true }).click();
  await page.getByRole("button", { name: "显示行号", exact: true }).click();
  await expect(editor.locator(".table-row-numbers span")).toHaveCount(2);
  await page.getByRole("button", { name: "关闭菜单" }).click();
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload();
  await expect(editor.locator("tr")).toHaveCount(2);
  await expect(editor.locator("ul")).toContainText("单元格列表");
  await expect(editor.locator(".table-row-numbers span")).toHaveCount(2);
});

test("v5 external table paste pads short rows and rejects merged cells before editing", async ({ page }) => {
  await open(page); const editor = page.locator(".prose-editor"); await editor.click();
  await editor.evaluate(element => {
    const transfer = new DataTransfer(); transfer.setData("text/html", "<table><tr><th>A</th><th>B</th></tr><tr><td>C</td></tr></table>");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator("tr")).toHaveCount(2);
  await expect(editor.locator("tr").nth(1).locator("td,th")).toHaveCount(2);
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.reload(); await expect(editor.locator("tr").nth(1).locator("td,th")).toHaveCount(2);

  await editor.click(); await page.keyboard.press("End");
  await editor.evaluate(element => {
    const transfer = new DataTransfer(); transfer.setData("text/html", "<table><tr><td colspan='2'>merged</td></tr></table>");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("alert")).toContainText("暂不支持含合并单元格");
  await expect(editor.locator("table")).toHaveCount(1);
});
