import { test, expect, openWorkspaceMenu } from "./fixtures";
import { testEmail, testPassword } from "./credentials";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/"); await page.getByLabel("邮箱", { exact: true }).fill(testEmail());
  await page.getByLabel("密码", { exact: true }).fill(testPassword()); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}
// UUIDv7 produced in the test process works in dev and built preview alike.
import { uuidv7 } from "../../src/api/client";
async function addNote(page: import("@playwright/test").Page, title: string) {
  return page.evaluate(async ({ title, operation_id }) => {
    const session = await (await fetch("/api/session")).json() as { csrfToken: string };
    const response = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ operation_id, content_schema_version: 15, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }, { type: "paragraph", content: [{ type: "text", text: "body" }] }] } }) });
    if (!response.ok) throw new Error(`Create: ${response.status}`); return response.json() as Promise<{ id: number; revision: number }>;
  }, { title, operation_id: uuidv7() });
}
test("reuses details, sends manual 304, and reloads disk copies read-only until unconditional validation", async ({ page }) => {
  await login(page); const first = await addNote(page, "cache-first-" + Date.now()), second = await addNote(page, "cache-second-" + Date.now());
  const details: { id: string; condition: string | undefined; status: number }[] = [];
  page.on("response", response => { const match = /\/api\/notes\/(\d+)$/.exec(response.url()); if (match && response.request().method() === "GET") details.push({ id: match[1]!, condition: response.request().headers()["if-none-match"], status: response.status() }); });
  await page.goto(`/notes/${first.id}`); await expect(page.getByLabel("笔记标题")).toHaveValue(/cache-first/); await expect(page.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  await page.locator(`[data-note-id="${second.id}"]`).click(); await expect(page.getByLabel("笔记标题")).toHaveValue(/cache-second/);
  await page.evaluate(() => {
    const state = window as unknown as { cacheStatusFlashed: boolean; cacheStatusObserver: MutationObserver };
    state.cacheStatusFlashed = false;
    state.cacheStatusObserver = new MutationObserver(records => {
      for (const record of records) {
        if ([...record.addedNodes, ...(record.type === "characterData" ? [record.target] : [])].some(node => node.textContent?.includes("正在检查更新"))) state.cacheStatusFlashed = true;
      }
    });
    state.cacheStatusObserver.observe(document.querySelector(".editor-panel")!, { childList: true, subtree: true, characterData: true });
  });
  await page.locator(`[data-note-id="${first.id}"]`).click(); await expect(page.getByLabel("笔记标题")).toHaveValue(/cache-first/);
  await expect(page.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  expect(await page.evaluate(() => {
    const state = window as unknown as { cacheStatusFlashed: boolean; cacheStatusObserver: MutationObserver };
    state.cacheStatusObserver.disconnect(); return state.cacheStatusFlashed;
  })).toBe(false);
  await expect(page.locator(".note-refresh")).toHaveText("");
  await expect(page.locator(".note-refresh svg")).toHaveCount(1);
  expect(details.filter(x => x.id === String(first.id))).toHaveLength(1);
  await page.getByRole("button", { name: "检查笔记更新" }).click();
  await expect.poll(() => details.filter(x => x.id === String(first.id)).length).toBe(2);
  expect(details.at(-1)?.status).toBe(304); expect(details.at(-1)?.condition).toBeTruthy();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/notes/${first.id}`, async route => { await held; await route.continue(); });
  await page.reload(); await expect(page.getByLabel("笔记标题")).toHaveValue(/cache-first/);
  await expect(page.getByLabel("笔记标题")).toHaveAttribute("readonly", "");
  await expect(page.locator(".note-cache-status")).toHaveText("正在检查更新");
  await expect(page.locator(".editor-panel > .draft-banner")).toHaveCount(0);
  release();
  await expect(page.getByText("正在检查更新", { exact: true })).not.toBeVisible();
  expect(details.at(-1)?.condition).toBeUndefined();
  await expect(page.getByLabel("笔记标题")).not.toHaveAttribute("readonly", "");
});
test("cache cleanup keeps the editor and draft intact and does not redownload immediately", async ({ page }) => {
  await login(page); const note = await addNote(page, "cache-clean-" + Date.now()); await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  await page.getByLabel("笔记标题").fill("unsaved-cache-draft");
  let count = 0; page.on("request", request => { if (request.url().endsWith(`/api/notes/${note.id}`) && request.method() === "GET") count++; });
  await openWorkspaceMenu(page); await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "清理笔记缓存", exact: true }).click();
  await expect(page.getByText("笔记缓存已清理", { exact: true })).toBeVisible();
  expect(count).toBe(0); await page.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.getByLabel("笔记标题")).toHaveValue("unsaved-cache-draft");
});
test("server updates refresh clean editors but retain unsaved edits as a conflict", async ({ page }) => {
  await login(page); const note = await addNote(page, "cache-remote-" + Date.now()); await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  const updateRemote = async (revision: number, title: string) => page.evaluate(async ({ id, revision, title, operation_id }) => {
    const session = await (await fetch("/api/session")).json() as { csrfToken: string };
    const response = await fetch(`/api/notes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ operation_id, expected_revision: revision, content_schema_version: 15, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }, { type: "paragraph", content: [{ type: "text", text: "remote body" }] }] } }) });
    if (!response.ok) throw new Error(`Patch: ${response.status}`);
    return (await response.json() as { note: { revision: number } }).note.revision;
  }, { id: note.id, revision, title, operation_id: uuidv7() });
  const revision = await updateRemote(note.revision, "remote-clean-update");
  await page.getByRole("button", { name: "检查笔记更新" }).click(); await expect(page.getByLabel("笔记标题")).toHaveValue("remote-clean-update");
  await page.getByLabel("笔记标题").fill("local-unsaved-update");
  await updateRemote(revision, "remote-conflicting-update");
  await page.getByRole("button", { name: "检查笔记更新" }).click();
  await expect(page.locator(".conflict-banner")).toBeVisible(); await expect(page.getByLabel("笔记标题")).toHaveValue("local-unsaved-update");
  await page.locator(".conflict-banner").getByRole("button", { name: "使用服务器版" }).click();
  await expect(page.getByLabel("笔记标题")).toHaveValue("remote-conflicting-update");
});
test("another tab's saved content is checked on focus and logout clears persistent copies", async ({ page, context }) => {
  await login(page); const note = await addNote(page, "cache-tabs-" + Date.now()); await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  const other = await context.newPage(); await other.goto(`/notes/${note.id}`);
  await expect(other.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  await other.getByLabel("笔记标题").fill("saved-from-other-tab"); await other.keyboard.press("ControlOrMeta+s");
  await expect(other.locator(".save-state")).toContainText("已保存到服务器");
  await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("笔记标题")).toHaveValue("saved-from-other-tab");
  await openWorkspaceMenu(page); await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("uranus-note-cache"); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const request = db.transaction("notes").objectStore("notes").count(); request.onsuccess = () => { resolve(request.result); db.close(); }; request.onerror = () => reject(request.error); };
  }))).toBe(0);
  await other.close();
});

test("failed reload validation keeps its local preview read-only and clears the status after retry", async ({ page }) => {
  await login(page); const note = await addNote(page, "cache-retry-" + Date.now()); await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("button", { name: "检查笔记更新" })).toBeEnabled();
  // Wait for the disposable copy to commit before restarting the application.
  await expect.poll(() => page.evaluate(id => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("uranus-note-cache"); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const request = db.transaction("metadata").objectStore("metadata").getAll();
      request.onsuccess = () => { resolve(request.result.some((row: { noteId: number }) => row.noteId === id)); db.close(); };
      request.onerror = () => reject(request.error);
    };
  }), note.id)).toBe(true);
  await page.route(`**/api/notes/${note.id}`, route => route.abort("failed"));
  await page.reload();
  await expect(page.getByLabel("笔记标题")).toHaveValue(/cache-retry/);
  await expect(page.locator(".note-cache-status")).toHaveText("本地副本，暂未确认最新");
  await expect(page.getByLabel("笔记标题")).toHaveAttribute("readonly", "");
  await expect(page.locator(".editor-panel > .draft-banner")).toHaveCount(0);
  await page.unroute(`**/api/notes/${note.id}`);
  await page.getByRole("button", { name: "检查笔记更新" }).click();
  await expect(page.locator(".note-cache-status")).toHaveCount(0);
  await expect(page.getByLabel("笔记标题")).not.toHaveAttribute("readonly", "");
});
