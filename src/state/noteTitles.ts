import { listNotes } from "../api/client";
import { identity, identityMatches } from "./identity";
import { normalizeSearch } from "../../shared/content";
import { RECENT_NOTE_LIMIT } from "../../shared/recentNotes";

export type NoteTitle = { id: number; title: string };
export type TitleIndex = { items: NoteTitle[]; complete: boolean };
export const TITLE_STALE_TIME = 600_000;
// Share the existing list invalidation prefix without persisting the index.
export const titleIndexKey = (userId: string | null) => ["user", userId, "notes", "title-index"] as const;
export const filterTitles = (items: NoteTitle[], query: string, excludeId?: number) => items.filter(item => item.id !== excludeId && normalizeSearch(item.title).includes(normalizeSearch(query.trim()))).slice(0, 50);
export async function loadTitleIndex(signal: AbortSignal): Promise<TitleIndex> {
  const owner = identity(), items = new Map<number, NoteTitle>();
  for (let page = 1; page <= 50; page++) {
    const result = await listNotes({}, page, signal);
    if (signal.aborted || !identityMatches(owner)) throw new DOMException("Cancelled", "AbortError");
    for (const { id, title } of result.items) items.set(id, { id, title });
    if (!result.hasMore) return { items: [...items.values()], complete: true };
  }
  return { items: [...items.values()], complete: false };
}
export async function resolveLinkTitles(ids: number[], signal: AbortSignal, index?: TitleIndex): Promise<NoteTitle[]> {
  const owner = identity(), found = new Map<number, NoteTitle>();
  for (const item of index?.items ?? []) if (ids.includes(item.id)) found.set(item.id, item);
  const missing = ids.filter(id => !found.has(id));
  // The existing API permits 20 IDs, not the 100 assumed by the initial plan.
  for (let offset = 0; offset < missing.length; offset += RECENT_NOTE_LIMIT) {
    const result = await listNotes({ ids: missing.slice(offset, offset + RECENT_NOTE_LIMIT) }, 1, signal);
    if (signal.aborted || !identityMatches(owner)) throw new DOMException("Cancelled", "AbortError");
    for (const { id, title, deletedAt } of result.items) if (!deletedAt) found.set(id, { id, title });
  }
  return [...found.values()];
}
