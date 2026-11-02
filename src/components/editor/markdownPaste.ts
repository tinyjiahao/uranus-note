import type { ContentNode } from "../../../shared/dto";
import { MAX_FILE_BYTES } from "../../../shared/files";
import { CURRENT_SCHEMA_VERSION } from "../../../shared/schemaVersion";
import { validateAndDeriveContent } from "../../../shared/content";

// V9-06: conservative plain-text Markdown conversion. Unsupported syntax stays
// text, and the complete generated document is validated before insertion.
export type PendingImage = { file: File; alt: string; src: string };
export type ParsedMarkdown = { blocks: ContentNode[]; pending: PendingImage[] };

const BLOCK_RE = /^(#{1,6}\s|>\s?|```|[-*+]\s|\d+\.\s|[-*+]\s\[[ xX]\]\s|(-{3,}|\*{3,}|_{3,})\s*$|\|.*\|)/;

export function parseMarkdownPaste(text: string): ParsedMarkdown | null {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed.length < 3 || !trimmed.includes("\n")) return null;
  if (/^[{[]/.test(trimmed) && !/^\[(?:[^\]]+)\]\(/.test(trimmed)) return null;
  const withoutDestinations = trimmed.replace(/!?\[[^\]]*\]\((?:https?:\/\/|mailto:)[^\s)]+\)/gi, "").replace(/```[\s\S]*?```/g, "");
  if (/https?:\/\/\S+/i.test(withoutDestinations)) return null;
  const lines = trimmed.split("\n");
  if (!lines.some(line => BLOCK_RE.test(line))) return null;
  const pending: PendingImage[] = [], blocks: ContentNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push({ type: "codeBlock", attrs: { language: fence[1]?.toLowerCase() || null }, content: body.length ? [{ type: "text", text: body.join("\n") }] : [] });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: "horizontalRule" }); i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { blocks.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inline(heading[2]!, pending) }); i++; continue; }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push({ type: "blockquote", content: paragraphs(body, pending) }); continue;
    }
    if (isTableStart(lines, i)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) tableLines.push(lines[i++]!);
      blocks.push(table(tableLines, pending)); continue;
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const rows: Array<{ task: boolean; checked: boolean; content: ContentNode }> = [];
      while (i < lines.length) {
        const match = lines[i]!.match(/^(\s*)([-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/);
        if (!match || /\d/.test(match[2]!) !== ordered) break;
        rows.push({ task: match[3] !== undefined, checked: match[3]?.toLowerCase() === "x", content: { type: "paragraph", content: inline(match[4]!, pending) } }); i++;
      }
      const task = !ordered && rows.length > 0 && rows.every(row => row.task);
      blocks.push(task
        ? { type: "taskList", content: rows.map(row => ({ type: "taskItem", attrs: { checked: row.checked }, content: [row.content] })) }
        : { type: ordered ? "orderedList" : "bulletList", ...(ordered ? { attrs: { start: Number(listMatch[2]!.slice(0, -1)) || 1 } } : {}), content: rows.map(row => ({ type: "listItem", content: [row.content] })) });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // This is an ordinary paragraph by elimination. Always consume the
    // current line first: a pipe-delimited line that is not followed by a
    // GFM delimiter row matches BLOCK_RE but is not a table.
    const body: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() && !BLOCK_RE.test(lines[i]!)) body.push(lines[i++]!);
    blocks.push({ type: "paragraph", content: inline(body.join(" "), pending) });
  }
  if (!blocks.length) return null;
  const parsed = { blocks, pending };
  return validates(parsed) ? parsed : null;
}

function paragraphs(lines: string[], pending: PendingImage[]): ContentNode[] {
  const out: ContentNode[] = []; let buffer: string[] = [];
  for (const line of [...lines, ""]) {
    if (line.trim()) buffer.push(line);
    else if (buffer.length) { out.push({ type: "paragraph", content: inline(buffer.join(" "), pending) }); buffer = []; }
  }
  return out.length ? out : [{ type: "paragraph" }];
}

function isTableStart(lines: string[], index: number) {
  return index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]!) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1]!);
}

function table(rows: string[], pending: PendingImage[]): ContentNode {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
  const [header, , ...body] = rows, values = [cells(header!), ...body.map(cells)];
  const width = Math.max(...values.map(row => row.length));
  return { type: "table", attrs: { widthMode: "fluid" }, content: values.map((row, rowIndex) => ({ type: "tableRow", content: Array.from({ length: width }, (_, cellIndex) => ({
    type: rowIndex === 0 ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: [{ type: "paragraph", content: inline((row[cellIndex] ?? "").replace(/<br\s*\/?>/gi, " "), pending) }],
  })) })) };
}

export function decodeDataImage(src: string): File | null {
  const match = src.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match || match[2]!.replace(/\s/g, "").length > Math.ceil(MAX_FILE_BYTES / 3) * 4) return null;
  try {
    const binary = atob(match[2]!.replace(/\s/g, ""));
    if (binary.length > MAX_FILE_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], `pasted-image.${match[1]!.split("/")[1]!.replace("jpeg", "jpg")}`, { type: match[1]! });
  } catch { return null; }
}

function safeDestination(value: string): string | null {
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return null;
  try { const url = new URL(value); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

const textNode = (text: string, marks: ContentNode["marks"] = []): ContentNode => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
function withMark(nodes: ContentNode[], mark: NonNullable<ContentNode["marks"]>[number]) { return nodes.map(node => node.type === "text" ? { ...node, marks: [...(node.marks ?? []), mark] } : node); }

function closingIndex(value: string, delimiter: string) {
  let from = delimiter.length;
  for (;;) {
    const found = value.indexOf(delimiter, from);
    if (found < 0) return -1;
    let slashes = 0;
    for (let index = found - 1; index >= 0 && value[index] === "\\"; index--) slashes++;
    if (slashes % 2 === 0) {
      // In **bold *italic*** the outer strong delimiter is the final two
      // stars, leaving the preceding star to close the nested emphasis.
      if (delimiter.length === 2 && value[found + delimiter.length] === delimiter[0]) return found + 1;
      return found;
    }
    from = found + delimiter.length;
  }
}

function inline(value: string, pending: PendingImage[]): ContentNode[] {
  const out: ContentNode[] = [];
  const append = (nodes: ContentNode[]) => { for (const node of nodes) { const previous = out.at(-1); if (previous?.type === "text" && node.type === "text" && JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])) previous.text = (previous.text ?? "") + (node.text ?? ""); else out.push(node); } };
  let rest = value;
  while (rest) {
    if (rest[0] === "\\" && rest.length > 1) { append([textNode(rest[1]!)]); rest = rest.slice(2); continue; }
    const image = rest.match(/^!\[([^\]]*)\]\(([^)\s]+)\)/);
    if (image) {
      const file = decodeDataImage(image[2]!);
      if (file) { pending.push({ file, alt: image[1]!, src: image[2]! }); out.push({ type: "inlineImage", attrs: { pending: pending.length - 1, src: "", alt: image[1]! } }); }
      else {
        const href = safeDestination(image[2]!);
        append(href ? [textNode(image[1] || image[2]!, [{ type: "link", attrs: { href } }])] : [textNode(`[${image[1]}](${image[2]})`)]);
      }
      rest = rest.slice(image[0].length); continue;
    }
    const anchor = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (anchor) {
      const href = safeDestination(anchor[2]!);
      append(href ? withMark(inline(anchor[1]!, pending), { type: "link", attrs: { href } }) : [textNode(anchor[0])]);
      rest = rest.slice(anchor[0].length); continue;
    }
    const code = rest.match(/^`([^`]+)`/);
    if (code) { append([textNode(code[1]!, [{ type: "code" }])]); rest = rest.slice(code[0].length); continue; }
    const tokens = [
      { open: "**", close: "**", mark: { type: "bold" } }, { open: "__", close: "__", mark: { type: "bold" } },
      { open: "~~", close: "~~", mark: { type: "strike" } }, { open: "==", close: "==", mark: { type: "highlight" } },
      { open: "*", close: "*", mark: { type: "italic" } }, { open: "_", close: "_", mark: { type: "italic" } },
    ] as const;
    const token = tokens.find(candidate => rest.startsWith(candidate.open) && closingIndex(rest, candidate.close) > candidate.open.length);
    if (token) { const end = closingIndex(rest, token.close); append(withMark(inline(rest.slice(token.open.length, end), pending), token.mark)); rest = rest.slice(end + token.close.length); continue; }
    const next = rest.slice(1).search(/[\\!\[`*_~=]/), length = next < 0 ? rest.length : next + 1;
    append([textNode(rest.slice(0, length))]); rest = rest.slice(length);
  }
  return out;
}

function validates(parsed: ParsedMarkdown): boolean {
  const replacePending = (node: ContentNode): ContentNode => typeof node.attrs?.pending === "number"
    ? { type: "inlineImage", attrs: { attachmentId: "pending", src: "/api/attachments/pending", alt: String(node.attrs.alt ?? "") } }
    : node.content ? { ...node, content: node.content.map(replacePending) } : node;
  try { validateAndDeriveContent({ type: "doc", content: parsed.blocks.map(replacePending) }, CURRENT_SCHEMA_VERSION); return true; } catch { return false; }
}
