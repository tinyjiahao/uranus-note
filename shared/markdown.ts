import type { ContentNode } from "./dto";
import { ContentValidationError } from "./content";

const encoder = new TextEncoder();

function text(value: string): ContentNode[] {
  return value ? [{ type: "text", text: value }] : [];
}

export function markdownToContent(markdown: string): ContentNode {
  if (encoder.encode(markdown).byteLength > 1_500_000) throw new ContentValidationError("IMPORT_TOO_LARGE", "Markdown 文件超过导入限制", 413);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: ContentNode[] = [];
  let code: string[] | null = null;
  let codeLanguage = "";
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) { content.push({ type: "codeBlock", attrs: { language: codeLanguage || null }, content: text(code.join("\n")) }); code = null; codeLanguage = ""; }
      else { code = []; codeLanguage = line.slice(3).trim(); }
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: text(heading[2]!) }); continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { content.push({ type: "horizontalRule" }); continue; }
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) { content.push({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: task[1]?.toLowerCase() === "x" }, content: [{ type: "paragraph", content: text(task[2]!) }] }] }); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { content.push({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: text(bullet[1]!) }] }] }); continue; }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) { content.push({ type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: text(ordered[1]!) }] }] }); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { content.push({ type: "blockquote", content: [{ type: "paragraph", content: text(quote[1]!) }] }); continue; }
    content.push({ type: "paragraph", content: text(line) });
  }
  if (code) content.push({ type: "codeBlock", attrs: { language: codeLanguage || null }, content: text(code.join("\n")) });
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
