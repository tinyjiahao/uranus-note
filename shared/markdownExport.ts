import type { ContentNode } from "./dto";

export function safeFileName(value: string, fallback: string) {
  let clean = "";
  for (const point of Array.from(value.normalize("NFC").replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_").replace(/^[. ]+|[. ]+$/g, "")).slice(0, 100)) {
    if (new TextEncoder().encode(clean + point).length > 180) break;
    clean += point;
  }
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(clean)) clean = "_" + clean;
  return clean || fallback;
}
const escape = (value: string) => value.replace(/([\\`*_{}\[\]<>#!|~])/g, "\\$1");
const destination = (value: string) => value.replace(/[\s()<>\\]/g, character => character === "(" ? "%28" : character === ")" ? "%29" : encodeURIComponent(character));
export function nodeText(node: ContentNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "label") return `[${String(node.attrs?.text ?? "")}]`;
  if (node.type === "noteLink") return `[[${String(node.attrs?.title ?? "") }]]`;
  if (node.type === "fileAttachment") return String(node.attrs?.fileName ?? "");
  return (node.content ?? []).map(nodeText).join(["paragraph", "heading"].includes(node.type ?? "") ? "" : "\n");
}
export function attachmentFiles(doc: ContentNode) {
  const files = new Map<string, string>();
  const visit = (node: ContentNode) => {
    if (["image", "fileAttachment"].includes(node.type ?? "") && typeof node.attrs?.attachmentId === "string") {
      const id = node.attrs.attachmentId;
      const name = safeFileName(String(node.attrs.fileName ?? node.attrs.alt ?? "image"), "attachment");
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
      files.set(id, `attachments/${stem}-${safeFileName(id, "id")}${ext}`);
    }
    node.content?.forEach(visit);
  };
  visit(doc); return files;
}
export function toMarkdown(doc: ContentNode) {
  const assets = attachmentFiles(doc);
  const inline = (node: ContentNode): string => {
    if (node.type === "hardBreak") return "  \n";
    if (node.type === "label" || node.type === "noteLink") return nodeText(node);
    let value = escape(node.text ?? "");
    if (node.marks?.some(mark => mark.type === "code")) {
      const raw = node.text ?? "", fence = "`".repeat(Math.max(0, ...[...raw.matchAll(/`+/g)].map(m => m[0].length)) + 1);
      value = `${fence} ${raw} ${fence}`;
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") value = `**${value}**`;
      if (mark.type === "italic") value = `*${value}*`;
      if (mark.type === "strike") value = `~~${value}~~`;
      if (mark.type === "link") value = `[${value}](${destination(String(mark.attrs?.href ?? ""))})`;
    }
    return value;
  };
  const block = (node: ContentNode): string => {
    const children = node.content ?? [];
    switch (node.type) {
      case "paragraph": return children.map(inline).join("");
      case "heading": return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${children.map(inline).join("")}`;
      case "blockquote": return children.map(block).join("\n\n").split("\n").map(line => `> ${line}`).join("\n");
      case "horizontalRule": return "---";
      case "codeBlock": {
        const value = children.map(child => child.text ?? "").join("");
        const fence = "`".repeat(Math.max(2, ...[...value.matchAll(/`+/g)].map(m => m[0].length)) + 1);
        const language = String(node.attrs?.language ?? "").replace(/[^a-zA-Z0-9_+.-]/g, "");
        return `${fence}${language}\n${value}\n${fence}`;
      }
      case "bulletList": case "orderedList": case "taskList": return children.map((child, index) => {
        const prefix = node.type === "orderedList" ? `${(Number(node.attrs?.start) || 1) + index}. ` : node.type === "taskList" ? `- [${child.attrs?.checked ? "x" : " "}] ` : "- ";
        return prefix + (child.content ?? []).map(block).join("\n\n").replaceAll("\n", "\n" + " ".repeat(prefix.length));
      }).join("\n");
      case "table": {
        const cellText = (cell: ContentNode): string => {
          if (cell.type === "fileAttachment") return block(cell);
          if (!cell.content) return nodeText(cell);
          return cell.content.map(cellText).join(["paragraph", "heading"].includes(cell.type ?? "") ? "" : "\n");
        };
        const rows = children.map(row => (row.content ?? []).map(cell => cellText(cell).replace(/\n+/g, "<br>").replaceAll("|", "\\|")));
        if (!rows.length) return "";
        if (!children[0]?.content?.some(cell => cell.type === "tableHeader")) rows.unshift(rows[0]!.map(() => ""));
        rows.splice(1, 0, rows[0]!.map(() => "---"));
        return rows.map(row => `| ${row.join(" | ")} |`).join("\n");
      }
      case "image": case "fileAttachment": {
        const label = escape(String(node.attrs?.alt ?? node.attrs?.fileName ?? ""));
        const path = (assets.get(String(node.attrs?.attachmentId)) ?? "").split("/").map(encodeURIComponent).join("/");
        return `${node.type === "image" ? "!" : ""}[${label}](${destination(path)})`;
      }
      default: return nodeText(node);
    }
  };
  const nodes = doc.content ?? [], first = nodes[0];
  const projected = first && ["paragraph", "heading"].includes(first.type ?? "") && (first.content ?? []).every(child => ["text", "hardBreak"].includes(child.type ?? ""));
  return nodes.map((node, index) => index === 0 && projected ? (nodeText(node).trim() ? "# " + escape(nodeText(node).replaceAll("\n", " ")) : "") : block(node)).filter(Boolean).join("\n\n") + "\n";
}
