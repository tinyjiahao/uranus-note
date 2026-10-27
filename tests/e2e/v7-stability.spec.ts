import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";

test.use({ trace: "off" });
test("composition pauses do not refresh EditorView props during local saving", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByTitle("新建笔记 (⌘N)").click();
  const body = page.locator(".prose-editor");
  await body.fill("正文");
  await page.keyboard.press("End");
  await page.evaluate(() => {
    const view = (document.querySelector(".prose-editor") as unknown as { editor: { view: { setProps: (...args: unknown[]) => unknown } } }).editor.view;
    const original = view.setProps.bind(view);
    (window as unknown as { v7Props: number }).v7Props = 0;
    view.setProps = (...args) => { (window as unknown as { v7Props: number }).v7Props++; return original(...args); };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "zheng", selectionStart: 5, selectionEnd: 5 });
  await page.waitForTimeout(1800);
  const calls = await page.evaluate(() => (window as unknown as { v7Props: number }).v7Props);
  await cdp.send("Input.insertText", { text: "正常" });
  await expect(body).toHaveText("正文正常");
  expect(calls).toBe(0);
  const title = page.getByLabel("笔记标题", { exact: true });
  await title.fill("");
  await cdp.send("Input.imeSetComposition", { text: "biao", selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(1800);
  await cdp.send("Input.insertText", { text: "标题" });
  await expect(title).toHaveValue("标题");
});

test("save indicator commits do not render NoteEditor", async ({ page }) => {
  await page.addInitScript(() => {
    type Fiber = { type?: unknown; memoizedProps?: { note?: unknown; onPersistLocal?: unknown }; flags: number; child?: Fiber; sibling?: Fiber };
    const state = window as unknown as { v7RenderCount: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    state.v7RenderCount = 0;
    const renderers = new Map<number, unknown>();
    state.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers, inject: (renderer: unknown) => { renderers.set(1, renderer); return 1; }, onCommitFiberUnmount() {}, onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const walk = (fiber?: Fiber) => { if (!fiber) return; if (typeof fiber.type === "function" && fiber.memoizedProps?.note && typeof fiber.memoizedProps?.onPersistLocal === "function" && (fiber.flags & 1)) state.v7RenderCount++; walk(fiber.child); walk(fiber.sibling); };
      walk(root.current);
    } };
  });
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail()); await page.getByLabel("密码", { exact: true }).fill(testPassword());
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByTitle("新建笔记 (⌘N)").click();
  await page.locator(".prose-editor").fill("保存状态隔离"); await page.waitForTimeout(250);
  const count = () => page.evaluate(() => (window as unknown as { v7RenderCount: number }).v7RenderCount);
  const before = await count(); expect(before).toBeGreaterThan(0);
  await expect(page.locator(".save-state")).toContainText("已存本机");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  expect(await count()).toBe(before);
});
