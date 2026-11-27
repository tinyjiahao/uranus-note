import { test, expect } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
import { uuidv7 } from "../../src/api/client";
import type { JSONContent } from "@tiptap/core";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword()); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
async function create(page: import("@playwright/test").Page, title: string, blocks: JSONContent[] = []) {
  return page.evaluate(async ({ title, blocks, operation_id }) => {
    const session = await (await fetch("/api/session")).json() as { csrfToken: string };
    const response = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ operation_id, content_schema_version: 15, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }, ...blocks] } }) });
    if (!response.ok) throw new Error(`Create failed: ${response.status}`);
    return response.json() as Promise<{ id: number }>;
  }, { title, blocks, operation_id: uuidv7() });
}
const link = (id: number, title: string): JSONContent => ({ type: "paragraph", content: [{ type: "noteLink", attrs: { noteId: id, title } }] });
test("batches link titles and reconciles app/browser navigation", async ({ page }) => {
  await login(page);
  const suffix = Date.now(), c = await create(page, `V12 C ${suffix}`, [p("C body")]);
  const b = await create(page, `V12 B ${suffix}`, [link(c.id, "stale C")]);
  const a = await create(page, `V12 A ${suffix}`, [link(b.id, "stale B"), link(c.id, "stale C"), link(b.id, "duplicate"), link(9007199254740991, "missing snapshot")]);
  const requests: string[] = [];
  page.on("request", request => { if (request.method() === "GET" && request.url().includes("/api/notes")) requests.push(request.url()); });
  await page.goto(`/notes/${a.id}`);
  await expect(page.locator(".note-link a").first()).toHaveText(`V12 B ${suffix}`);
  await expect(page.locator(".note-link-missing")).toHaveText("missing snapshot（不可用）");
  expect(requests.filter(url => new URL(url).searchParams.has("ids"))).toHaveLength(1);
  expect(requests.filter(url => /\/api\/notes\/\d+$/.test(url))).toHaveLength(1);
  await expect(page.getByRole("button", { name: "回退", exact: true })).toBeDisabled();
  await page.locator(".note-link a").first().dblclick(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 B ${suffix}`);
  await page.locator(".note-link a").dblclick(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 C ${suffix}`);
  await page.getByRole("button", { name: "回退", exact: true }).click(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 B ${suffix}`);
  await page.getByRole("button", { name: "回退", exact: true }).click(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 A ${suffix}`);
  await page.getByRole("button", { name: "前进", exact: true }).click(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 B ${suffix}`);
  await page.goBack(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 A ${suffix}`);
  await page.goForward(); await expect(page.getByLabel("笔记标题")).toHaveValue(`V12 B ${suffix}`);
  await page.reload(); await expect(page.getByRole("button", { name: "回退", exact: true })).toBeDisabled();
});
test("searches link titles locally, reuses the index and bounds suggestions", async ({ page }, testInfo) => {
  await login(page); const ownTitle = `V12 popup ${Date.now()}`;
  await create(page, "V12 popup other candidate", [p("body")]);
  const note = await create(page, ownTitle, [p("body")]);
  await page.goto(`/notes/${note.id}`); await expect(page.locator(".prose-editor")).toBeVisible();
  const open = async () => { await page.getByRole("button", { name: "更多格式与插入", exact: true }).click(); await page.getByRole("button", { name: "插入笔记链接", exact: true }).click(); };
  await open(); const popup = page.getByRole("dialog", { name: "插入笔记链接" });
  await expect(popup.locator(".note-link-candidates button").first()).toBeVisible({ timeout: 60_000 });
  await expect(popup.getByRole("status")).toHaveCount(0);
  let count = 0; page.on("request", request => { if (new URL(request.url()).pathname === "/api/notes" && request.method() === "GET") count++; });
  await expect(popup.getByRole("button", { name: ownTitle, exact: true })).toHaveCount(0);
  await page.getByLabel("搜索笔记标题").fill(ownTitle);
  await expect(popup.getByText("未找到笔记", { exact: true })).toBeVisible();
  await page.getByLabel("搜索笔记标题").fill("V12"); await page.getByLabel("搜索笔记标题").fill("V12 popup");
  await expect(popup.locator(".note-link-candidates button").first()).toContainText("V12 popup");
  await page.getByLabel("搜索笔记标题").fill("");
  const box = await popup.locator(".note-link-candidates").boundingBox(); expect(box!.height).toBeLessThanOrEqual(280);
  await page.getByLabel("搜索笔记标题").press("ArrowDown"); await expect(popup.locator(".note-link-candidates button").first()).toBeFocused();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await popup.screenshot({ path: testInfo.outputPath(`note-link-${theme}.png`) });
  }
  await page.keyboard.press("Escape"); await open(); await expect(popup.locator(".note-link-candidates button").first()).toBeVisible();
  expect(count).toBe(0);
  await page.getByLabel("搜索笔记标题").press("Escape");
  const renamed = `V12 renamed ${Date.now()}`;
  await page.getByLabel("笔记标题", { exact: true }).fill(renamed);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await open(); await page.getByLabel("搜索笔记标题").fill(renamed);
  await expect(popup.locator(".note-link-candidates button")).toHaveCount(0);
  await expect(popup.getByText("未找到笔记", { exact: true })).toBeVisible();
  expect(count).toBeGreaterThan(0);
});
for (const native of [true, false]) test(`keeps natural table height with editor-scroll sticky headers and code icons (${native ? "native" : "fallback"})`, async ({ page }, testInfo) => {
  if (!native) await page.addInitScript(() => Object.defineProperty(window, "ScrollTimeline", { value: undefined, configurable: true }));
  await page.addInitScript(() => {
    const state = window as unknown as { blockScrollTest: boolean; scrollTestAbort: AbortController };
    state.scrollTestAbort = new AbortController();
    window.addEventListener("scroll", event => { if (state.blockScrollTest) event.stopImmediatePropagation(); }, { capture: true, signal: state.scrollTestAbort.signal });
  });
  await login(page);
  const table: JSONContent = { type: "table", content: Array.from({ length: 40 }, (_, row) => ({ type: "tableRow", content: [0, 1].map(col => ({ type: row === 0 ? "tableHeader" : "tableCell", content: [p(`${row === 0 ? "Header" : row}-${col}`)] })) })) };
  const note = await create(page, `V12 styles ${Date.now()}`, [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: '{"a":1}' }] }, table, ...Array.from({ length: 30 }, () => p('After table'))]);
  await page.goto(`/notes/${note.id}`); await expect(page.locator(".code-format svg")).toBeVisible();
  await page.getByRole("button", { name: "格式化", exact: true }).click(); await expect(page.locator("pre")).toContainText('"a": 1');
  await expect(page.locator(".code-copy")).toHaveAttribute("title", "复制代码");
  await page.evaluate(() => { localStorage.setItem("uranus.table.rowNumbers", "1"); window.dispatchEvent(new Event("uranus-table-row-numbers")); });
  const wrapper = page.locator(".tableWrapper"), header = wrapper.locator("th").first();
  await expect(header).toBeVisible();
  await expect(wrapper).toHaveCSS("max-height", "none");
  expect((await wrapper.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height);
  expect(await wrapper.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await wrapper.evaluate(el => { el.scrollTop = 300; });
  expect(await wrapper.evaluate(el => el.scrollTop)).toBe(0);
  const scroller = page.locator(".editor-content");
  const scrollPastHeader = async (distance: number) => {
    const port = (await scroller.boundingBox())!, tableBox = (await wrapper.locator("table").boundingBox())!;
    await scroller.evaluate((el, delta) => { el.scrollTop += delta; }, tableBox.y - port.y + distance);
  };
  await scrollPastHeader(300);
  await expect.poll(async () => Math.abs((await header.boundingBox())!.y - (await scroller.boundingBox())!.y)).toBeLessThan(2);
  const corner = wrapper.locator(".table-row-number-header").first();
  await expect(corner).toBeVisible();
  expect(Math.abs((await corner.boundingBox())!.y - (await header.boundingBox())!.y)).toBeLessThan(2);
  await expect(wrapper).toHaveAttribute("data-header-stuck", "");
  expect(await header.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  await scroller.evaluate(el => { el.scrollTop += 300; });
  await expect.poll(async () => Math.abs((await header.boundingBox())!.y - (await scroller.boundingBox())!.y)).toBeLessThan(2);
  await expect(wrapper).toHaveAttribute("data-header-driver", native ? "scroll-timeline" : "fallback");
  // Stop JS scroll handlers entirely: the browser timeline must still keep
  // the header pinned, including reverse scrolling.
  await page.evaluate(enabled => { (window as unknown as { blockScrollTest: boolean }).blockScrollTest = enabled; }, native);
  await scroller.hover();
  for (const delta of [160, -140, 200, -180]) {
    const before = await scroller.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, delta);
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).not.toBe(before);
    await expect.poll(async () => Math.abs((await header.boundingBox())!.y - (await scroller.boundingBox())!.y)).toBeLessThan(2);
  }
  await page.evaluate(() => (window as unknown as { scrollTestAbort: AbortController }).scrollTestAbort.abort());
  // A wide table keeps the same horizontal coordinates for header and body.
  await wrapper.locator("table").evaluate(el => { el.style.minWidth = "1800px"; });
  await wrapper.evaluate(el => { el.scrollLeft = 250; });
  expect(await wrapper.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(Math.abs((await header.boundingBox())!.x - (await wrapper.locator("td").first().boundingBox())!.x)).toBeLessThan(1);
  await wrapper.locator("table").evaluate(el => { el.style.minWidth = ""; });
  await wrapper.locator("tr").last().scrollIntoViewIfNeeded();
  await expect(wrapper.locator("tr").last()).toBeInViewport();
  const tableBottom = await wrapper.locator("table").boundingBox();
  const headerBottom = await header.boundingBox();
  expect(headerBottom!.y + headerBottom!.height).toBeLessThanOrEqual(tableBottom!.y + tableBottom!.height + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollPastHeader(300);
  await expect.poll(async () => Math.abs((await header.boundingBox())!.y - (await scroller.boundingBox())!.y)).toBeLessThan(2);
  await expect(wrapper).toHaveCSS("max-height", "none");
  const bottom = (await wrapper.locator("table").boundingBox())!, port = (await scroller.boundingBox())!;
  await scroller.evaluate((el, delta) => { el.scrollTop += delta; }, bottom.y + bottom.height - port.y + 10);
  await expect.poll(async () => { const rect = (await header.boundingBox())!; return rect.y + rect.height; }).toBeLessThan((await scroller.boundingBox())!.y + 1);
  await page.setViewportSize({ width: 1280, height: 720 });
  await scrollPastHeader(300);
  await page.emulateMedia({ media: "print" });
  await expect(header).toHaveCSS("transform", "none");
  await page.emulateMedia({ media: "screen" });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    expect(await header.evaluate(el => getComputedStyle(el).borderBottomWidth)).toBe("1px");
    expect(await header.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: testInfo.outputPath(`table-${theme}.png`) });
  }
});
test("falls back after 50 index pages and replaces deleted navigation entries", async ({ page }) => {
  await login(page); const note = await create(page, `V12 guard ${Date.now()}`, [p("body")]);
  await page.goto(`/notes/${note.id}`); await expect(page.locator(".prose-editor")).toBeVisible();
  const indexPages = new Set<number>();
  await page.route("**/api/notes?*", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("ids")) { await route.continue(); return; }
    const query = url.searchParams.get("q");
    if (!query) indexPages.add(Number(url.searchParams.get("page")));
    await route.fulfill({ json: { items: query ? [{ id: note.id, title: "fallback self" }, { id: note.id === 1 ? 2 : 1, title: "fallback candidate" }] : [], page: Number(url.searchParams.get("page")), hasMore: !query, totalCount: 3000 } });
  });
  await page.getByRole("button", { name: "更多格式与插入", exact: true }).click();
  await page.getByRole("button", { name: "插入笔记链接", exact: true }).click();
  await page.getByLabel("搜索笔记标题").fill("fallback");
  await expect(page.getByRole("button", { name: "fallback candidate", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "fallback self", exact: true })).toHaveCount(0);
  expect(indexPages.size).toBe(50);
  expect(Math.max(...indexPages)).toBe(50);
  await page.getByLabel("搜索笔记标题").press("Escape");
  await page.unroute("**/api/notes?*");
  await page.getByRole("button", { name: "笔记更多", exact: true }).click();
  await page.getByRole("button", { name: "移入最近删除", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "回退", exact: true })).toBeDisabled();
});
test("selects, copies, cuts and pastes a note link as a node", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  const target = await create(page, `Clipboard target ${Date.now()}`, [p("target body")]);
  const destination = await create(page, "Clipboard destination", [p("destination body")]);
  const source = await create(page, "Clipboard source", [link(target.id, "Clipboard snapshot")]);
  await page.goto(`/notes/${source.id}`);
  const chip = page.locator(".note-link"), body = page.locator(".prose-editor");
  await expect(chip.locator("a")).toContainText("Clipboard target");
  await chip.locator("a").click();
  await expect(chip).toHaveClass(/ProseMirror-selectednode/);
  await expect(page.getByRole("dialog", { name: "笔记链接", exact: true })).toBeVisible();
  await expect(chip.locator("button")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/notes/${source.id}$`));
  await page.keyboard.press("ControlOrMeta+c");
  const copied = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return (await items[0]!.getType("text/html")).text();
  });
  expect(copied).toContain('data-note-link="1"');
  expect(copied).toContain(`data-id="${target.id}"`);
  await chip.locator("a").click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "笔记链接", exact: true });
  await expect(menu).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: testInfo.outputPath(`note-link-menu-${theme}.png`), animations: "disabled" });
  }
  await menu.getByRole("button", { name: "复制", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await chip.locator("a").click({ button: "right" });
  await menu.getByRole("button", { name: "剪切", exact: true }).click();
  await expect(chip).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chip).toHaveCount(1);
  await chip.locator("a").click(); await page.keyboard.press("Backspace");
  await expect(chip).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chip).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".save-state")).toContainText("已保存到服务器");
  await page.goto(`/notes/${destination.id}`);
  await expect(body).toContainText("destination body");
  await body.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".note-link a")).toHaveAttribute("href", `/notes/${target.id}`);
  await page.locator(".note-link a").click();
  await page.getByRole("button", { name: "打开笔记", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${target.id}$`));
});
