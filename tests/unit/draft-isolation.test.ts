import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getDraft, putDraft, clearDrafts } from "../../src/state/drafts";
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
it("isolates the same note id by stable user identity", async () => {
  const draft = { noteId: 1, baseRevision: 1, contentSchemaVersion: 5 as const, editSequence: 1, updatedAt: 1, content: { type: "doc", content: [{ type: "paragraph" }] } };
  await putDraft(draft, "a");
  expect(await getDraft(1, "b")).toBeUndefined();
  await clearDrafts("b");
  expect(await getDraft(1, "a")).toMatchObject(draft);
  expect(await getDraft(1, "a", true)).toBeUndefined();
  await expect(putDraft(draft, null)).rejects.toThrow("未登录");
});
