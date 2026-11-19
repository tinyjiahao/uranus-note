/** Bump when the full NoteDetail representation changes incompatibly. */
export const NOTE_REPRESENTATION_VERSION = "1";
export function noteEtag(userId: string, noteId: number, revision: number): string {
  return `"note-${encodeURIComponent(userId)}-${noteId}-${revision}-${NOTE_REPRESENTATION_VERSION}"`;
}
/** Compression at the HTTP edge may weaken a 200 validator but leave 304 strong. */
export function sameNoteEtag(a: string | null, b: string | null): boolean {
  const entityTag = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/;
  return a !== null && b !== null && entityTag.test(a) && entityTag.test(b) && a.replace(/^W\//, "") === b.replace(/^W\//, "");
}
/** If-None-Match uses weak comparison for GET requests. */
export function matchesNoteEtag(header: string, etag: string): boolean {
  return header.trim() === "*" || (header.match(/(?:W\/)?"[^"\r\n]*"/g) ?? []).some(value => sameNoteEtag(value, etag));
}
