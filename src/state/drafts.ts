import { type ContentSchemaVersion } from "../../shared/schemaVersion";
import type { ContentNode } from "../../shared/dto";
import { identity } from "./identity";

export type Draft = { noteId: number; baseRevision: number; contentSchemaVersion: ContentSchemaVersion; editSequence: number; updatedAt: number; content: ContentNode; legacy?: boolean };
const DB_NAME = "uranus-drafts";
const STORE = "drafts";

function openDatabase(userId: string | null, legacy = false): Promise<IDBDatabase> {
  if (!userId) return Promise.reject(new Error("未登录，无法访问本机草稿"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(legacy ? DB_NAME : DB_NAME + "-v6:" + userId, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "noteId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putDraft(draft: Draft, userId = identity().userId): Promise<boolean> {
  const db = await openDatabase(userId);
  let stored = false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const existing = store.get(draft.noteId);
    existing.onsuccess = () => {
      const current = existing.result as Draft | undefined;
      if (!current || current.editSequence < draft.editSequence || (current.editSequence === draft.editSequence && current.baseRevision <= draft.baseRevision)) { store.put(draft); stored = true; }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return stored;
}

export async function getDraft(noteId: number, userId = identity().userId, legacy = false): Promise<Draft | undefined> {
  const db = await openDatabase(userId, legacy);
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(noteId);
    request.onsuccess = () => { db.close(); resolve(request.result ? { ...request.result, legacy } as Draft : undefined); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function deleteDraftIfSequence(noteId: number, sequence: number, userId = identity().userId, legacy = false): Promise<void> {
  const db = await openDatabase(userId, legacy);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(noteId);
    request.onsuccess = () => {
      const current = request.result as Draft | undefined;
      if (current && current.editSequence === sequence) store.delete(noteId);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function clearDrafts(userId = identity().userId): Promise<void> {
  const db = await openDatabase(userId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
