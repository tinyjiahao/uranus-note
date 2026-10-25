import type { ContentNode } from "../../../shared/dto";

// A view-level split only: persisted documents, drafts and history retain the
// original title block followed by the body. Never extract a table/list cell.
export function splitNoteTitle(doc: ContentNode) {
  const first = doc.content?.[0];
  const extract = first && ["paragraph", "heading"].includes(first.type ?? "")
    && (first.content ?? []).every(node => node.type === "text" || node.type === "hardBreak");
  return {
    title: extract ? first : { type: "paragraph" } as ContentNode,
    body: { ...doc, content: extract ? doc.content!.slice(1) : [...(doc.content ?? [])] },
  };
}

export function titleText(node: ContentNode) {
  return (node.content ?? []).map(child => child.type === "hardBreak" ? "\n" : child.text ?? "").join("");
}

// Preserve marks on unchanged text and the block's original heading/alignment.
export function updateTitle(node: ContentNode, text: string): ContentNode {
  const previous = titleText(node);
  let start = 0;
  while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
  // Don't split a UTF-16 surrogate pair across differently marked text nodes.
  if (start > 0 && /[\uD800-\uDBFF]/.test(previous[start - 1]!) && /[\uDC00-\uDFFF]/.test(previous[start] ?? "")) start--;
  let end = previous.length, nextEnd = text.length;
  while (end > start && nextEnd > start && previous[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
  if (end < previous.length && /[\uDC00-\uDFFF]/.test(previous[end]!) && /[\uD800-\uDBFF]/.test(previous[end - 1] ?? "")) { end++; nextEnd++; }
  const slice = (from: number, to: number) => {
    let offset = 0;
    return (node.content ?? []).flatMap(child => {
      const length = child.type === "hardBreak" ? 1 : (child.text ?? "").length;
      const a = Math.max(0, from - offset), b = Math.min(length, to - offset); offset += length;
      return a < b ? [child.type === "hardBreak" ? child : { ...child, text: child.text!.slice(a, b) }] : [];
    });
  };
  const inserted: ContentNode[] = text.slice(start, nextEnd).split("\n").flatMap((line, index) => [
    ...(index ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : []),
  ]);
  return { ...node, content: [...slice(0, start), ...inserted, ...slice(end, previous.length)] };
}

export function joinNoteTitle(title: ContentNode, body: ContentNode): ContentNode {
  return { ...body, content: [title, ...(body.content ?? [])] };
}
