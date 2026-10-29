import type { ContentNode } from "./dto";

export type ContentStats = {
  bytes: number;
  characters: number;
  charactersNoSpace: number;
  words: number;
  readingMinutes: number;
  paragraphs: number;
  headings: number;
  images: number;
  tables: number;
  links: number;
  codeBlocks: number;
  labels: number;
  noteLinks: number;
  files: number;
  tasks: { done: number; total: number };
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORDS_PER_MINUTE = 300;

// Pure, client-side summary of a TipTap document. Text mirrors what search/char_count index (text, label, note-link title, file name).
export function computeContentStats(doc: ContentNode): ContentStats {
  const stats: ContentStats = {
    bytes: new TextEncoder().encode(JSON.stringify(doc)).length, characters: 0, charactersNoSpace: 0, words: 0, readingMinutes: 0,
    paragraphs: 0, headings: 0, images: 0, tables: 0, links: 0, codeBlocks: 0, labels: 0, noteLinks: 0, files: 0, tasks: { done: 0, total: 0 },
  };
  const pieces: string[] = [];
  const walk = (node: ContentNode) => {
    switch (node.type) {
      case "text":
        pieces.push(node.text ?? "");
        return;
      case "label": stats.labels++; pieces.push(String(node.attrs?.text ?? "")); return;
      case "noteLink": stats.noteLinks++; pieces.push(String(node.attrs?.title ?? "")); return;
      case "fileAttachment": case "inlineFile": stats.files++; pieces.push(String(node.attrs?.fileName ?? ""), "\n"); return;
      case "image": case "inlineImage": stats.images++; return;
      case "table": stats.tables++; break;
      case "codeBlock": stats.codeBlocks++; break;
      case "heading": stats.headings++; break;
      case "taskItem": stats.tasks.total++; if (node.attrs?.checked) stats.tasks.done++; break;
      case "paragraph": if (node.content?.some(child => child.type === "text" ? Boolean(child.text?.trim()) : child.type !== "hardBreak")) stats.paragraphs++; break;
    }
    let previousHref: unknown;
    node.content?.forEach(child => {
      const href = child.marks?.find(mark => mark.type === "link")?.attrs?.href;
      if (href !== undefined && href !== previousHref) stats.links++;
      previousHref = href;
      walk(child);
    });
    if (["paragraph", "heading", "blockquote", "codeBlock", "listItem", "taskItem", "tableCell", "tableHeader"].includes(node.type ?? "")) pieces.push("\n");
  };
  walk(doc);
  const text = pieces.join("").replace(/\n{3,}/g, "\n\n").trim();
  stats.characters = Array.from(text).length;
  stats.charactersNoSpace = Array.from(text.replace(/\s/gu, "")).length;
  stats.words = (text.match(CJK)?.length ?? 0) + (text.replace(CJK, " ").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0);
  stats.readingMinutes = stats.words ? Math.max(1, Math.ceil(stats.words / WORDS_PER_MINUTE)) : 0;
  return stats;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"]; let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}
