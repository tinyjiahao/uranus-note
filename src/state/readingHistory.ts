import { RECENT_NOTE_LIMIT } from "../../shared/recentNotes";
import { readPreference, writePreference } from "./ui";

type ReadingEntry = { id: number; top: number };
const key = (userId: string) => "uranus.readingHistory." + userId;
const fallback = new Map<string, ReadingEntry[]>();

export function readReadingHistory(userId: string): ReadingEntry[] {
  try {
    const stored: unknown = JSON.parse(readPreference(key(userId)) ?? "null");
    if (Array.isArray(stored)) {
      const entries = new Map<number, ReadingEntry>();
      for (const entry of stored.slice(0, RECENT_NOTE_LIMIT)) {
        if (entry && Number.isSafeInteger(entry.id) && entry.id > 0 && Number.isFinite(entry.top) && entry.top >= 0 && !entries.has(entry.id)) {
          entries.set(entry.id, { id: entry.id, top: entry.top });
        }
      }
      return [...entries.values()];
    }
  } catch { /* Ignore malformed preferences. */ }
  return fallback.get(userId) ?? [];
}

function save(userId: string, entries: ReadingEntry[]) {
  fallback.set(userId, entries);
  writePreference(key(userId), JSON.stringify(entries));
}

export function markNoteOpened(userId: string, id: number) {
  const entries = readReadingHistory(userId);
  const previous = entries.find(entry => entry.id === id);
  const next = [previous ?? { id, top: 0 }, ...entries.filter(entry => entry.id !== id)].slice(0, RECENT_NOTE_LIMIT);
  save(userId, next);
  return next.map(entry => entry.id);
}

export function saveReadingPosition(userId: string, id: number, top: number) {
  const entries = readReadingHistory(userId);
  const entry = entries.find(item => item.id === id);
  if (!entry || entry.top === top) return;
  save(userId, entries.map(item => item.id === id ? { id, top } : item));
}
