import type { NoteListItem } from "./dto";

// SQLite substr/instr count Unicode code points, unlike JS String.slice/indexOf.
export function searchMatch(source: "title" | "body", text: string, query: string, before = false, after = false): NonNullable<NoteListItem["searchMatch"]> {
  const points = Array.from(text).slice(0, 200);
  const bounded = points.join("");
  const ranges: [number, number][] = [];
  if (query) {
    let offset = 0;
    while (offset < bounded.length) {
      const hit = bounded.indexOf(query, offset); if (hit < 0) break;
      const start = Array.from(bounded.slice(0, hit)).length;
      ranges.push([start, start + Array.from(query).length]); offset = hit + query.length;
    }
  }
  return { source, text: bounded, ranges, normalized: true, before, after };
}
