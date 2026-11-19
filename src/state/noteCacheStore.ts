import type { NoteDetail } from "../../shared/dto";
import { supportsSchema } from "../../shared/schemaVersion";
import { validateAndDeriveContent } from "../../shared/content";
import { NOTE_REPRESENTATION_VERSION } from "../../shared/noteCache";

export const CACHE_FORMAT = 2;
export const CACHE_LIMIT = 50_000_000;
export type CacheEntry = {
  key: string; userId: string; noteId: number; revision: number; contentSchemaVersion: number;
  etag: string | null; representationVersion: string; cacheFormatVersion: number;
  note: NoteDetail; validatedAt: number; lastAccessedAt: number; byteSize: number;
};
export type Barrier = { account: number; note: number; writes: number };
type Metadata = Omit<CacheEntry, "note">;
const keyOf = (user: string, id: number) => JSON.stringify([user, id]);
const accountKey = (user: string) => JSON.stringify([user]);
export function makeEntry(userId: string, note: NoteDetail, validatedAt: number, etag: string | null, representationVersion: string): CacheEntry {
  // Explicit DTO whitelist: search fragments, credentials and optimistic query state cannot enter storage.
  const copy: NoteDetail = { id: note.id, folderId: note.folderId, title: note.title, snippet: note.snippet, revision: note.revision,
    pinned: note.pinned, starred: note.starred, deletedAt: note.deletedAt, createdAt: note.createdAt, updatedAt: note.updatedAt,
    contentSchemaVersion: note.contentSchemaVersion, content: note.content };
  const entry: CacheEntry = { key: keyOf(userId, note.id), userId, noteId: note.id, revision: note.revision,
    contentSchemaVersion: note.contentSchemaVersion, etag, representationVersion, cacheFormatVersion: CACHE_FORMAT,
    note: copy, validatedAt, lastAccessedAt: Date.now(), byteSize: 0 };
  for (let i = 0; i < 3; i++) entry.byteSize = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  return entry;
}
export function validEntry(value: unknown, user: string, id: number): value is CacheEntry {
  try {
    const e = value as CacheEntry;
    if (!e || e.key !== keyOf(user, id) || e.userId !== user || e.noteId !== id || e.cacheFormatVersion !== CACHE_FORMAT ||
      e.representationVersion !== NOTE_REPRESENTATION_VERSION || !supportsSchema(e.contentSchemaVersion) ||
      e.note.id !== id || e.note.revision !== e.revision || e.note.contentSchemaVersion !== e.contentSchemaVersion ||
      !Number.isSafeInteger(e.revision) || e.revision < 1 || !Number.isFinite(e.validatedAt) || !Number.isFinite(e.lastAccessedAt) ||
      !Number.isFinite(e.byteSize) || e.byteSize < 1 || e.byteSize > CACHE_LIMIT ||
      !(e.etag === null || typeof e.etag === "string") || typeof e.note.title !== "string" || typeof e.note.snippet !== "string" ||
      typeof e.note.pinned !== "boolean" || typeof e.note.starred !== "boolean" || !Number.isSafeInteger(e.note.folderId)) return false;
    validateAndDeriveContent(e.note.content, e.contentSchemaVersion);
    return true;
  } catch { return false; }
}
function value<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function completed(tx: IDBTransaction) { const promise = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Cache transaction aborted")); }); void promise.catch(() => {}); return promise; }
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("uranus-note-cache", CACHE_FORMAT);
    request.onupgradeneeded = () => {
      // This database contains disposable server copies only, never drafts.
      for (const name of Array.from(request.result.objectStoreNames)) request.result.deleteObjectStore(name);
      request.result.createObjectStore("notes", { keyPath: "key" });
      request.result.createObjectStore("metadata", { keyPath: "key" }).createIndex("userId", "userId");
      request.result.createObjectStore("barriers");
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Cache upgrade blocked"));
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    const tx = db.transaction(["notes", "metadata", "barriers"], mode), done = completed(tx);
    try { const result = await run(tx); await done; return result; }
    catch (error) { try { tx.abort(); } catch { /* already completed or aborted */ } await done.catch(() => {}); throw error; }
  } finally { db.close(); }
}
async function barrier(tx: IDBTransaction, user: string, id: number): Promise<Barrier> {
  const store = tx.objectStore("barriers");
  const [account, note] = await Promise.all([value(store.get(accountKey(user))), value(store.get(keyOf(user, id)))]);
  return { account: Number(account ?? 0), note: Number(note?.note ?? 0), writes: Number(note?.writes ?? 0) };
}
export const sameBarrier = (a: Barrier, b: Barrier) => a.account === b.account && a.note === b.note;
export function loadCache(user: string, id: number, includeBody: boolean) {
  return transaction("readwrite", async tx => {
    const stamp = await barrier(tx, user, id);
    const raw: unknown = includeBody ? await value(tx.objectStore("notes").get(keyOf(user, id))) : undefined;
    if (!includeBody) {
      const meta = await value(tx.objectStore("metadata").get(keyOf(user, id))) as Metadata | undefined;
      if (meta && Date.now() - meta.lastAccessedAt >= 1000) { meta.lastAccessedAt = Date.now(); tx.objectStore("metadata").put(meta); }
    }
    let entry: CacheEntry | undefined;
    if (raw !== undefined) {
      if (validEntry(raw, user, id)) { entry = raw; entry.lastAccessedAt = Date.now(); tx.objectStore("metadata").put(metadata(entry)); }
      else { tx.objectStore("notes").delete(keyOf(user, id)); tx.objectStore("metadata").delete(keyOf(user, id)); }
    }
    return { barrier: stamp, entry };
  });
}
function metadata(entry: CacheEntry): Metadata { const { note: _, ...meta } = entry; return meta; }
async function trim(tx: IDBTransaction, user: string, emergency = false) {
  const metas = await value(tx.objectStore("metadata").index("userId").getAll(user)) as Metadata[];
  metas.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  let size = 0;
  metas.forEach((meta, index) => {
    size += meta.byteSize;
    if (index >= (emergency ? Math.floor(metas.length / 2) : 100) || size > CACHE_LIMIT) {
      tx.objectStore("notes").delete(meta.key); tx.objectStore("metadata").delete(meta.key);
    }
  });
}
export async function storeCache(entry: CacheEntry, expected: Barrier, mode: "baseline" | "read" | "write", valid: () => boolean): Promise<boolean> {
  if (entry.byteSize > CACHE_LIMIT) return false;
  const attempt = () => transaction("readwrite", async tx => {
    const current = await barrier(tx, entry.userId, entry.noteId);
    if (!valid() || !sameBarrier(expected, current) || (mode !== "write" && expected.writes !== current.writes)) return false;
    const store = tx.objectStore("notes");
    const old = await value(store.get(entry.key)) as CacheEntry | undefined;
    if (!valid()) return false;
    if (mode !== "baseline" && old && old.revision > entry.revision) return false;
    if (mode !== "baseline" && old?.revision === entry.revision && old.validatedAt > entry.validatedAt) return false;
    store.put(entry); tx.objectStore("metadata").put(metadata(entry));
    tx.objectStore("barriers").put({ note: current.note, writes: current.writes + 1 }, entry.key);
    await trim(tx, entry.userId);
    if (!valid()) { tx.abort(); return false; }
    return true;
  });
  try { return await attempt(); } catch (error) {
    if ((error as Error).name !== "QuotaExceededError") throw error;
    await transaction("readwrite", tx => trim(tx, entry.userId, true));
    return attempt();
  }
}
export function clearStoredCache(user: string, id?: number) {
  return transaction("readwrite", async tx => {
    const store = tx.objectStore("barriers");
    if (id !== undefined) {
      const current = await barrier(tx, user, id);
      store.put({ note: current.note + 1, writes: current.writes }, keyOf(user, id));
      tx.objectStore("notes").delete(keyOf(user, id)); tx.objectStore("metadata").delete(keyOf(user, id));
    } else {
      store.put(Number(await value(store.get(accountKey(user))) ?? 0) + 1, accountKey(user));
      const keys = await value(tx.objectStore("metadata").index("userId").getAllKeys(user));
      for (const key of keys) { tx.objectStore("notes").delete(key); tx.objectStore("metadata").delete(key); }
    }
  });
}
