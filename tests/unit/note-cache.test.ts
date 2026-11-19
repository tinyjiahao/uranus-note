import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteDetail } from "../../shared/dto";
import { activateIdentity, identity } from "../../src/state/identity";
import { cacheBaselineUnsafe, clearNoteCache, readConfirmedNote, rememberListVersions, resetNoteCacheIdentity, beginCacheWrite, confirmCacheWrite, setCacheEnabled, type CacheTransport } from "../../src/state/noteCache";
import { clearStoredCache, loadCache, makeEntry, storeCache } from "../../src/state/noteCacheStore";
import { putDraft, getDraft } from "../../src/state/drafts";
const note = (revision = 1, id = 1, text = "hello"): NoteDetail => ({ id, folderId: 1, title: text, snippet: text, revision, contentSchemaVersion: 1, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, pinned: false, starred: false, deletedAt: null, createdAt: 1, updatedAt: 1 });
const response = (n = note(), startedAt = Date.now()) => ({ status: 200 as const, note: n, etag: `"${n.revision}"`, representationVersion: "1", startedAt });
const network = () => vi.fn<CacheTransport>(async () => response());
async function seed(n = note()) { const stamp = (await loadCache("a", n.id, false)).barrier; await storeCache(makeEntry("a", n, Date.now(), '"old"', "1"), stamp, "read", () => true); }
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const preferences = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value) });
  activateIdentity(null); activateIdentity("a"); resetNoteCacheIdentity();
});
afterEach(() => { resetNoteCacheIdentity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("merges reads, uses TTL without extending it on access, then sends the exact ETag", async () => {
  const fetch = network();
  await Promise.all([readConfirmedNote(1, fetch), readConfirmedNote(1, fetch)]);
  await readConfirmedNote(1, fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  fetch.mockImplementation(async etag => { expect(etag).toBe('"1"'); return { ...response(), status: 304 }; });
  await readConfirmedNote(1, fetch); expect(fetch).toHaveBeenCalledTimes(2);
});
it("always validates persistent copies unconditionally after activation; detects equal-revision restore", async () => {
  await seed(note(3, 1, "before restore"));
  const preview = vi.fn(), fetch = vi.fn<CacheTransport>(async etag => { expect(etag).toBeNull(); return response(note(3, 1, "restored")); });
  expect((await readConfirmedNote(1, fetch, undefined, { preview })).title).toBe("restored");
  expect(preview).toHaveBeenCalledTimes(1); expect(cacheBaselineUnsafe(1)).toBe(true);
});
it("rebuilds lower restored baseline and preserves unrelated drafts", async () => {
  await seed(note(5));
  await putDraft({ noteId: 1, baseRevision: 5, contentSchemaVersion: 1, content: note().content, editSequence: 1, updatedAt: 1 }, "a");
  await readConfirmedNote(1, async () => response(note(2)));
  await readConfirmedNote(1, network()); // waits for pending persistence
  expect((await loadCache("a", 1, true)).entry?.revision).toBe(2);
  expect(cacheBaselineUnsafe(1)).toBe(true);
  await clearNoteCache("a"); expect(await getDraft(1, "a")).toBeDefined();
});
it("fresh compatible list revisions reuse details using list request time, old/mismatched lists do not", async () => {
  const fetch = network(); await readConfirmedNote(1, fetch);
  const start = Date.now(); vi.spyOn(Date, "now").mockReturnValue(start + 61_000);
  rememberListVersions([note()], start + 60_000, "1", identity());
  await readConfirmedNote(1, fetch); expect(fetch).toHaveBeenCalledTimes(1);
  vi.spyOn(Date, "now").mockReturnValue(start + 121_000);
  rememberListVersions([note()], start + 120_000, "old-server", identity());
  await readConfirmedNote(1, fetch); expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not accept expired slow responses or clock rollback as fresh", async () => {
  const fetch = vi.fn<CacheTransport>(async () => response(note(), Date.now() - 61_000));
  await readConfirmedNote(1, fetch); await readConfirmedNote(1, fetch); expect(fetch).toHaveBeenCalledTimes(2);
  const normal = network(); await readConfirmedNote(2, async () => response(note(1, 2)));
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now - 10_000);
  await readConfirmedNote(2, async () => { normal(null, new AbortController().signal); return response(note(1, 2)); }); expect(normal).toHaveBeenCalledTimes(1);
});
it("clear barriers reject old writes across tabs even without BroadcastChannel", async () => {
  const stamp = (await loadCache("a", 1, false)).barrier;
  await clearStoredCache("a");
  expect(await storeCache(makeEntry("a", note(), Date.now(), null, "1"), stamp, "read", () => true)).toBe(false);
  const next = (await loadCache("a", 1, false)).barrier;
  await clearStoredCache("a", 1);
  expect(await storeCache(makeEntry("a", note(), Date.now(), null, "1"), next, "write", () => true)).toBe(false);
});
it("late conditional response cannot refresh or replace a newer confirmed save", async () => {
  await readConfirmedNote(1, network());
  let release!: (value: Awaited<ReturnType<CacheTransport>>) => void;
  let start!: () => void; const started = { promise: new Promise<void>(resolve => { start = resolve; }), resolve: () => start() };
  const reading = readConfirmedNote(1, () => { started.resolve(); return new Promise(resolve => { release = resolve; }); }, undefined, { force: true });
  await started.promise;
  const ticket = await beginCacheWrite(1); await confirmCacheWrite(note(2), ticket, Date.now());
  release({ ...response(), status: 304 });
  expect((await reading).revision).toBe(2);
  const fetch = network(); expect((await readConfirmedNote(1, fetch)).revision).toBe(2); expect(fetch).not.toHaveBeenCalled();
});
it("clear and account switch discard in-flight responses", async () => {
  let release!: (value: Awaited<ReturnType<CacheTransport>>) => void;
  let start!: () => void; const started = { promise: new Promise<void>(resolve => { start = resolve; }), resolve: () => start() };
  const reading = readConfirmedNote(1, () => { started.resolve(); return new Promise(resolve => { release = resolve; }); });
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await started.promise; await clearNoteCache("a"); activateIdentity("b"); release(response()); await rejected;
  expect((await loadCache("a", 1, true)).entry).toBeUndefined();
});
it("evicts to 100 records without reading all bodies and isolates accounts", async () => {
  await seed(note(1, 999));
  for (let id = 1; id <= 101; id++) await seed(note(1, id));
  expect((await loadCache("a", 999, true)).entry).toBeUndefined();
  expect((await loadCache("a", 101, true)).entry).toBeDefined();
  expect((await loadCache("b", 101, true)).entry).toBeUndefined();
});
it("disabling persistence preserves network reads and rejects old pending writes", async () => {
  const stamp = await beginCacheWrite(1);
  await setCacheEnabled("a", false); await confirmCacheWrite(note(), stamp, Date.now());
  await readConfirmedNote(1, network());
  expect((await loadCache("a", 1, true)).entry).toBeUndefined();
});
it("falls back to network when IndexedDB is unavailable", async () => {
  vi.stubGlobal("indexedDB", { open() { throw new Error("unavailable"); } });
  expect((await readConfirmedNote(1, network())).id).toBe(1);
});
it("rejects a cross-tab clear while a response is in flight", async () => {
  let release!: (value: Awaited<ReturnType<CacheTransport>>) => void;
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  const reading = readConfirmedNote(1, () => { start(); return new Promise(resolve => { release = resolve; }); });
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await started; await clearStoredCache("a"); release(response()); await rejected;
});
it("normal low versions and mismatched ETags cannot overwrite newer disk records", async () => {
  await seed(note(9)); const stamp = (await loadCache("a", 1, false)).barrier;
  expect(await storeCache(makeEntry("a", note(2), Date.now(), null, "1"), stamp, "read", () => true)).toBe(false);
  expect((await loadCache("a", 1, true)).entry?.revision).toBe(9);
});
it("corrupt or unsupported cached records are deleted before preview", async () => {
  const bad = makeEntry("a", note(), Date.now(), null, "1"); bad.contentSchemaVersion = 999;
  await storeCache(bad, (await loadCache("a", 1, false)).barrier, "read", () => true);
  expect((await loadCache("a", 1, true)).entry).toBeUndefined();
  const preview = vi.fn(); await readConfirmedNote(1, network(), undefined, { preview }); expect(preview).not.toHaveBeenCalled();
});
it("failed cleanup keeps drafts and disables persistent reuse without changing identity", async () => {
  await putDraft({ noteId: 1, baseRevision: 1, contentSchemaVersion: 1, content: note().content, editSequence: 1, updatedAt: 1 }, "a");
  const original = indexedDB;
  vi.stubGlobal("indexedDB", { open() { throw new Error("unavailable"); } });
  await expect(clearNoteCache("a")).rejects.toThrow("unavailable"); expect(identity().userId).toBe("a");
  expect((await readConfirmedNote(1, network())).id).toBe(1);
  vi.stubGlobal("indexedDB", original); expect(await getDraft(1, "a")).toBeDefined();
});
it("known newer list revisions and manual refresh override the TTL", async () => {
  const fetch = network(); await readConfirmedNote(1, fetch);
  rememberListVersions([note(2)], Date.now(), "1", identity()); fetch.mockResolvedValue(response(note(2)));
  expect((await readConfirmedNote(1, fetch)).revision).toBe(2);
  await readConfirmedNote(1, fetch, undefined, { force: true }); expect(fetch).toHaveBeenCalledTimes(3);
});
it("enforces the byte budget as well as record count and skips oversized entries", async () => {
  for (let id = 1; id <= 3; id++) {
    const entry = makeEntry("a", note(1, id), Date.now(), null, "1"); entry.byteSize = 20_000_000;
    await storeCache(entry, (await loadCache("a", id, false)).barrier, "read", () => true);
  }
  expect((await loadCache("a", 1, true)).entry).toBeUndefined();
  const tooLarge = makeEntry("a", note(1, 9), Date.now(), null, "1"); tooLarge.byteSize = 50_000_001;
  expect(await storeCache(tooLarge, (await loadCache("a", 9, false)).barrier, "read", () => true)).toBe(false);
});
it("does not repopulate cache after a clear that follows a write request's start", async () => {
  const ticket = await beginCacheWrite(1); await clearStoredCache("a");
  await confirmCacheWrite(note(2), ticket, Date.now());
  expect((await loadCache("a", 1, true)).entry).toBeUndefined();
});
it("ignores stale 404 after a newer save rather than deleting the confirmed copy", async () => {
  await readConfirmedNote(1, network());
  let reject!: (error: unknown) => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const reading = readConfirmedNote(1, () => { start(); return new Promise((_resolve, fail) => { reject = fail; }); }, undefined, { force: true });
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await started; await confirmCacheWrite(note(2), await beginCacheWrite(1), Date.now());
  reject(Object.assign(new Error("Not found"), { status: 404 })); await rejected;
  expect((await readConfirmedNote(1, network())).revision).toBe(2);
});

it("retries quota errors once after eviction and rolls back incomplete records", async () => {
  const stamp = (await loadCache("a", 1, false)).barrier;
  const original = IDBObjectStore.prototype.put;
  let attempts = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (value && typeof value === "object" && "contentSchemaVersion" in value && "note" in value && ++attempts === 1) throw new DOMException("Full", "QuotaExceededError");
    return original.call(this, value, key);
  });
  expect(await storeCache(makeEntry("a", note(), Date.now(), null, "1"), stamp, "read", () => true)).toBe(true);
  expect(attempts).toBe(2); spy.mockRestore();
  expect((await loadCache("a", 1, true)).entry?.note.id).toBe(1);
});
