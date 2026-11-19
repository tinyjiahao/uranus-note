/** Bump when the full NoteDetail representation changes incompatibly. */
export const NOTE_REPRESENTATION_VERSION = "1";
export function noteEtag(userId: string, noteId: number, revision: number): string {
  return `"note-${encodeURIComponent(userId)}-${noteId}-${revision}-${NOTE_REPRESENTATION_VERSION}"`;
}
/** If-None-Match uses weak comparison for GET requests. */
export function matchesNoteEtag(header: string, etag: string): boolean {
  return header.trim() === "*" || (header.match(/(?:W\/)?"[^"\r\n]*"/g) ?? []).some(value => value.replace(/^W\//, "") === etag);
}
