import type { ContentNode } from "../../shared/dto";

export type Draft = { noteId: number; baseRevision: number; contentSchemaVersion: 1 | 2 | 3; editSequence: number; updatedAt: number; content: ContentNode };
const DB_NAME = "uranus-drafts";
const STORE = "drafts";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "noteId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putDraft(draft: Draft): Promise<boolean> {
  const db = await openDatabase();
  let stored = false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const existing = store.get(draft.noteId);
    existing.onsuccess = () => {
      const current = existing.result as Draft | undefined;
      if (!current || current.editSequence <= draft.editSequence) { store.put(draft); stored = true; }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return stored;
}

export async function getDraft(noteId: number): Promise<Draft | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(noteId);
    request.onsuccess = () => { db.close(); resolve(request.result as Draft | undefined); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function deleteDraftIfSequence(noteId: number, sequence: number): Promise<void> {
  const db = await openDatabase();
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

export async function clearDrafts(): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
