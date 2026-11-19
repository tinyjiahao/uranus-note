import type { NoteDetail, NoteListItem } from "../../shared/dto";
import { NOTE_REPRESENTATION_VERSION, sameNoteEtag } from "../../shared/noteCache";
import { identity, identityMatches, onIdentityChange, identityTabId } from "./identity";
import { clearStoredCache, loadCache, makeEntry, sameBarrier, storeCache, type Barrier, type CacheEntry } from "./noteCacheStore";

export const CACHE_TTL = 60_000;
type Owner = ReturnType<typeof identity>;
type Runtime = { entry?: CacheEntry; barrier?: Barrier; trusted: boolean; unsafe: boolean; serial: number; write: number; mono: number; persistence?: Promise<unknown> };
export type CacheTransport = (etag: string | null, signal: AbortSignal) => Promise<{ status: 200 | 304; note?: NoteDetail; etag: string | null; representationVersion: string; startedAt: number }>;
export type CacheReadOptions = { force?: boolean; background?: boolean; preview?: (note: NoteDetail) => void };
const entries = new Map<number, Runtime>();
const lists = new Map<number, { revision: number; startedAt: number; mono: number; representation: string }>();
const pending = new Map<number, { controller: AbortController; promise: Promise<NoteDetail>; consumers: Set<symbol> }>();
let owner: Owner = { userId: null, epoch: -1 };
let generation = 0;
const disabled = new Set<string>();
const sessionPreferences = new Map<string, boolean>();
const key = (user: string) => `uranus-cache-disabled:${user}`;
const cleanupKey = (user: string) => `uranus-cache-cleanup:${user}`;
function preference(name: string) { try { return localStorage.getItem(name); } catch { return null; } }
function preferenceSet(name: string, value: string) { try { localStorage.setItem(name, value); } catch { /* session-only fallback */ } }
function cancelled(): never { throw new DOMException("Cache request superseded", "AbortError"); }
function reset() {
  for (const request of pending.values()) request.controller.abort();
  pending.clear(); entries.clear(); lists.clear(); generation++;
}
function current() { const next = identity(); if (!identityMatches(owner)) { reset(); owner = next; } return next; }
export function resetNoteCacheIdentity() { reset(); owner = identity(); }
export function cacheEnabled(user: string) { return !disabled.has(user) && (preference(key(user)) === null ? sessionPreferences.get(user) !== false : preference(key(user)) !== "1") && preference(cleanupKey(user)) !== "1"; }
function announce(userId: string, noteId?: number, revision?: number) {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel("uranus-note-cache");
    channel.postMessage({ userId, noteId, revision, sender: identityTabId }); channel.close();
  } catch { /* persisted barriers still protect browsers without messaging */ }
}
export function installCacheNotifications(onInvalidate: (id?: number) => void) {
  let channel: BroadcastChannel | undefined;
  try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel("uranus-note-cache"); } catch { /* use focus-time barriers */ }
  if (channel) channel.onmessage = event => {
    const data = event.data;
    if (!data || data.sender === identityTabId || data.userId !== current().userId) return;
    if (data.noteId !== undefined && !Number.isSafeInteger(data.noteId)) return;
    invalidateNoteMemory(data.noteId);
    if (data.revision !== undefined) onInvalidate(data.noteId);
  };
  return () => channel?.close();
}
export function invalidateNoteMemory(id?: number) {
  current();
  if (id === undefined) { reset(); return; }
  const item = entries.get(id); if (item) { item.trusted = false; item.serial++; }
  lists.delete(id); pending.get(id)?.controller.abort(); pending.delete(id);
}
export async function clearNoteCache(user: string, id?: number) {
  if (current().userId === user) invalidateNoteMemory(id);
  preferenceSet(cleanupKey(user), "1");
  try {
    await clearStoredCache(user, id);
    preferenceSet(cleanupKey(user), "0");
    disabled.delete(user);
    announce(user, id);
  } catch (error) { disabled.add(user); announce(user, id); throw error; }
}
export async function retryPendingCacheCleanup(user: string) {
  if (preference(cleanupKey(user)) === "1") await clearNoteCache(user).catch(() => {});
}
export async function setCacheEnabled(user: string, enabled: boolean) {
  sessionPreferences.set(user, enabled);
  preferenceSet(key(user), enabled ? "0" : "1");
  if (!enabled) disabled.add(user);
  await clearNoteCache(user);
}
export function cacheBaselineUnsafe(id: number) { current(); return entries.get(id)?.unsafe === true; }
export function acceptCacheBaseline(id: number) { const item = entries.get(id); if (item) item.unsafe = false; }
export function rememberListVersions(items: NoteListItem[], startedAt: number, representation: string, expected: Owner) {
  current(); if (!identityMatches(expected)) return;
  for (const item of items) {
    const previous = lists.get(item.id);
    if (!previous || previous.startedAt <= startedAt) lists.set(item.id, { revision: item.revision, startedAt, mono: performance.now() - Math.max(0, Date.now() - startedAt), representation });
  }
}
function fresh(at: number, mono: number) {
  const age = Date.now() - at, elapsed = performance.now() - mono;
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL && elapsed >= 0 && elapsed < CACHE_TTL;
}
function runtime(id: number) {
  let item = entries.get(id);
  if (!item) { item = { trusted: false, unsafe: false, serial: 0, write: 0, mono: 0 }; entries.set(id, item); }
  return item;
}
export async function beginCacheWrite(id?: number) {
  current(); const ticket = { owner: { ...owner }, generation, id, barrier: undefined as Barrier | undefined };
  if (owner.userId) { try { ticket.barrier = (await loadCache(owner.userId, id ?? 0, false)).barrier; } catch { /* network fallback */ } }
  return ticket;
}
export async function confirmCacheWrite(note: NoteDetail, ticket: Awaited<ReturnType<typeof beginCacheWrite>>, startedAt: number) {
  current(); if (!identityMatches(ticket.owner) || generation !== ticket.generation || !owner.userId) return;
  const item = runtime(note.id);
  if (item.entry && item.entry.revision > note.revision) return;
  item.write++; item.serial++; item.trusted = true;
  item.entry = makeEntry(owner.userId, note, startedAt, null, NOTE_REPRESENTATION_VERSION);
  item.mono = performance.now() - Math.max(0, Date.now() - startedAt);
  lists.delete(note.id);
  const serial = item.serial, expected = { ...owner }, gen = generation;
  const entry = item.entry;
  // Publish the whole persistence task before yielding so a following read can
  // wait for its barrier check without delaying the save receipt itself.
  item.persistence = (async () => {
    if (cacheEnabled(expected.userId!)) {
      try {
        const loaded = await loadCache(expected.userId!, note.id, false);
        if (item.serial !== serial || gen !== generation || !identityMatches(expected)) return;
        if (!ticket.barrier || loaded.barrier.account !== ticket.barrier.account || (ticket.id === note.id && !sameBarrier(ticket.barrier, loaded.barrier))) {
          item.trusted = false; delete item.entry; return;
        }
        item.barrier = loaded.barrier;
        const stored = await storeCache(entry, loaded.barrier, "write", () => item.serial === serial && gen === generation && identityMatches(expected) && cacheEnabled(expected.userId!));
        if (item.serial === serial && identityMatches(expected)) {
          if (stored) item.barrier = { ...loaded.barrier, writes: loaded.barrier.writes + 1 };
          else item.trusted = false;
        }
      } catch { /* a cache failure never changes save success */ }
    }
    if (identityMatches(expected) && gen === generation) announce(expected.userId!, note.id, note.revision);
  })();
  await item.persistence;
}
async function read(id: number, transport: CacheTransport, signal: AbortSignal, options: CacheReadOptions): Promise<NoteDetail> {
  const expected = { ...current() }, gen = generation;
  if (!expected.userId) cancelled();
  const user = expected.userId, item = runtime(id);
  const check = () => { if (!identityMatches(expected) || gen !== generation || signal.aborted) cancelled(); };
  let disk: Awaited<ReturnType<typeof loadCache>> | undefined;
  await item.persistence;
  check();
  const serial = ++item.serial, write = item.write;
  try { disk = await loadCache(user, id, cacheEnabled(user) && !item.entry); } catch { /* no persistent cache */ }
  check();
  if (disk && item.barrier && (!sameBarrier(item.barrier, disk.barrier) || item.barrier.writes !== disk.barrier.writes)) {
    item.trusted = false;
    if (!sameBarrier(item.barrier, disk.barrier)) { delete item.entry; lists.delete(id); }
  }
  if (disk) item.barrier = disk.barrier;
  if (!item.entry && disk?.entry && cacheEnabled(user)) item.entry = disk.entry;
  const candidate = item.entry;
  const baseline = !item.trusted;
  const list = lists.get(id);
  const compatibleList = list && fresh(list.startedAt, list.mono) && list.representation === NOTE_REPRESENTATION_VERSION && candidate?.representationVersion === list.representation;
  const knownDifferent = list && candidate && list.revision !== candidate.revision;
  if (candidate && disk && !options.force && !baseline) {
    if (compatibleList && list.revision === candidate.revision) {
      if (list.startedAt > candidate.validatedAt) { candidate.validatedAt = list.startedAt; item.mono = list.mono; }
      return candidate.note;
    }
    if (!knownDifferent && fresh(candidate.validatedAt, item.mono)) return candidate.note;
  }
  if (candidate) options.preview?.(candidate.note);
  const requestMono = performance.now();
  const fetch = async (etag: string | null) => {
    try { return await transport(etag, signal); }
    catch (error) { check(); if (item.write !== write || item.serial !== serial) cancelled(); throw error; }
  };
  const sentEtag = !baseline && candidate?.etag ? candidate.etag : null;
  let response = await fetch(sentEtag);
  check();
  if (item.write !== write) { if (item.entry) return item.entry.note; cancelled(); }
  if (item.serial !== serial) cancelled();
  // 304 validates precisely the snapshot sent, never a concurrent replacement.
  if (response.status === 304 && (!candidate || item.entry !== candidate || !sentEtag || !sameNoteEtag(response.etag, sentEtag) || response.representationVersion !== candidate.representationVersion)) {
    response = await fetch(null); check();
    if (response.status === 304) throw new Error("Unexpected 304 without a server copy");
  }
  let note = response.status === 304 ? candidate!.note : response.note!;
  if (!note || note.id !== id) throw new Error("Invalid note response");
  if (!baseline && candidate && note.revision < candidate.revision) {
    item.unsafe = true;
    response = await fetch(null); check();
    if (item.write !== write || item.serial !== serial) cancelled();
    if (response.status !== 200 || !response.note) throw new Error("Invalid authoritative response");
    note = response.note;
  }
  if (candidate && (note.revision < candidate.revision || (note.revision === candidate.revision && JSON.stringify(note.content) !== JSON.stringify(candidate.note.content)))) item.unsafe = true;
  check();
  if (disk) {
    const latest = await loadCache(user, id, false).catch(() => undefined); check();
    if (latest && !sameBarrier(disk.barrier, latest.barrier)) cancelled();
    if (latest && latest.barrier.writes !== disk.barrier.writes && item.write === write) cancelled();
  }
  if (item.write !== write || item.serial !== serial) cancelled();
  item.entry = makeEntry(user, note, response.startedAt, response.etag, response.representationVersion);
  item.trusted = true; item.mono = requestMono;
  const entry = item.entry;
  if (disk && cacheEnabled(user)) {
    item.persistence = storeCache(entry, disk.barrier, baseline || item.unsafe ? "baseline" : "read", () => identityMatches(expected) && gen === generation && item.serial === serial && !signal.aborted && cacheEnabled(user))
      .then(stored => {
        if (identityMatches(expected) && gen === generation && item.serial === serial) {
          if (stored) item.barrier = { ...disk.barrier, writes: disk.barrier.writes + 1 };
          else item.trusted = false;
        }
      })
      .catch(() => {});
  }
  return note;
}
export function readConfirmedNote(id: number, transport: CacheTransport, signal?: AbortSignal, options: CacheReadOptions = {}): Promise<NoteDetail> {
  current();
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (options.force) { pending.get(id)?.controller.abort(); pending.delete(id); }
  let job = pending.get(id);
  if (!job) {
    const controller = new AbortController();
    const requestedOwner = { ...owner };
    const promise = read(id, transport, controller.signal, options).catch(async error => {
      if ((error as { status?: number }).status === 404 && requestedOwner.userId && identityMatches(requestedOwner)) await clearNoteCache(requestedOwner.userId, id).catch(() => {});
      throw error;
    });
    job = { controller, promise, consumers: new Set() }; pending.set(id, job);
    const created = job;
    void promise.finally(() => { if (pending.get(id) === created) pending.delete(id); }).catch(() => {});
  }
  const active = job, consumer = Symbol(); active.consumers.add(consumer);
  return new Promise((resolve, reject) => {
    const release = () => { active.consumers.delete(consumer); signal?.removeEventListener("abort", abort); };
    const abort = () => { release(); if (!active.consumers.size) { active.controller.abort(); if (pending.get(id) === active) pending.delete(id); } reject(new DOMException("Cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    active.promise.then(note => { release(); if (!signal?.aborted) resolve(note); }, error => { release(); reject(error); });
  });
}

onIdentityChange(resetNoteCacheIdentity);
