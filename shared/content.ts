import { contentSchemaVersionSchema, CURRENT_SCHEMA_VERSION } from "./schemaVersion";
import { z } from "zod";
import { supportsSchema, SCHEMA_FEATURE } from "./schemaVersion";
import { labelAttributes } from "./label";
import { fileAttachmentAttributes } from "./files";
import { noteLinkAttributes } from "./noteLink";
import { isTextColor, isHighlightColor } from "./textColors";
import type { ContentNode } from "./dto";

export const MAX_CONTENT_BYTES = 1_500_000;
export const MAX_SEARCH_BYTES = 1_500_000;
export const MAX_NODES = 50_000;
export const MAX_DEPTH = 32;

const blockNodes = new Set([
  "doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem",
  "blockquote", "codeBlock", "horizontalRule", "hardBreak", "table", "tableRow", "tableHeader", "tableCell", "image", "text", "label", "fileAttachment", "noteLink",
]);
const markNodes = new Set(["bold", "italic", "underline", "strike", "code", "highlight", "link", "small", "textColor"]);

export const contentEnvelopeSchema = z.object({
  content_schema_version: contentSchemaVersionSchema,
  content: z.record(z.string(), z.unknown()),
});

export class ContentValidationError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export type DerivedContent = {
  serialized: string;
  title: string;
  snippet: string;
  plainText: string;
  normalizedTitle: string;
  normalizedText: string;
  charCount: number;
  attachmentIds: string[];
};

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const normalizeSearch = (value: string) => value.normalize("NFKC").toLowerCase();

function safeLink(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

export function validateAndDeriveContent(input: unknown, schemaVersion: number = CURRENT_SCHEMA_VERSION): DerivedContent {
  if (!supportsSchema(schemaVersion)) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "正文版本不受支持");
  const serialized = JSON.stringify(input);
  if (bytes(serialized) > MAX_CONTENT_BYTES) {
    throw new ContentValidationError("CONTENT_TOO_LARGE", "正文超过 1,500,000 字节限制", 413);
  }
  if (!input || typeof input !== "object" || (input as ContentNode).type !== "doc") {
    throw new ContentValidationError("INVALID_CONTENT", "正文必须是 TipTap doc 节点");
  }
  let count = 0;
  const textParts: string[] = [];
  const paragraphs: string[] = [];
  const attachments = new Set<string>();
  const walk = (node: ContentNode, depth: number, ancestors: string[] = []): string => {
    count++;
    if (count > MAX_NODES || depth > MAX_DEPTH) {
      throw new ContentValidationError("CONTENT_COMPLEXITY_EXCEEDED", "正文结构过于复杂");
    }
    if (!node.type || !blockNodes.has(node.type)) {
      throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", `不支持的正文节点：${node.type ?? "unknown"}`);
    }
    if (node.type === "paragraph" || node.type === "heading") {
      const alignment = node.attrs?.textAlign;
      if (alignment != null && (typeof alignment !== "string" || !["left", "center", "right"].includes(alignment))) throw new ContentValidationError("INVALID_ALIGNMENT", "正文对齐仅支持靠左、居中或靠右");
      if (alignment != null && schemaVersion < SCHEMA_FEATURE.alignment) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "正文对齐需要新版客户端，请刷新页面");
    }
    if (node.type === "table") {
      for (const key of Object.keys(node.attrs ?? {})) {
        if (key !== "widthMode") throw new ContentValidationError("INVALID_TABLE", "表格属性不受支持");
      }
      if (node.attrs?.widthMode != null && !["fluid", "fixed"].includes(String(node.attrs.widthMode))) throw new ContentValidationError("INVALID_TABLE", "表格宽度模式无效");
      const rows = node.content ?? [];
      const columns = rows[0]?.content?.length ?? 0;
      if (!rows.length || !columns || rows.some(row => row.type !== "tableRow" || row.content?.length !== columns)) throw new ContentValidationError("INVALID_TABLE", "表格必须包含等长的行");
    }
    if (node.type === "tableCell" || node.type === "tableHeader") {
      const richBlocks = new Set(["bulletList", "orderedList", "taskList", "blockquote", "codeBlock"]);
      for (const child of node.content ?? []) {
        if (child.type === "image") {
          if (schemaVersion < SCHEMA_FEATURE.imageAlignment) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "表格图片需要新版客户端，请刷新页面");
        } else if (child.type === "fileAttachment") {
          if (schemaVersion < SCHEMA_FEATURE.tableAttachments) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "表格附件需要新版客户端，请刷新页面");
        } else if (child.type === "paragraph") {
          if (child.content?.some(inline => !["text", "hardBreak", "label", "noteLink"].includes(inline.type ?? ""))) throw new ContentValidationError("INVALID_TABLE", "单元格段落包含不支持的节点");
        } else if (richBlocks.has(child.type ?? "")) {
          if (schemaVersion < SCHEMA_FEATURE.richCells) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "单元格富文本需要新版客户端，请刷新页面");
          let invalid = false;
          const allowed = new Set(["paragraph", "hardBreak", "text", "label", "noteLink", "fileAttachment", "bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote", "codeBlock"]);
          const check = (descendant: ContentNode) => {
            if (!allowed.has(descendant.type ?? "")) invalid = true;
            descendant.content?.forEach(check);
          };
          child.content?.forEach(check);
          if (invalid) throw new ContentValidationError("INVALID_TABLE", "单元格富文本不能包含嵌套表格、标题、分隔线或列表内图片");
        } else {
          throw new ContentValidationError("INVALID_TABLE", "单元格包含不支持的块类型");
        }
      }
      const attrs = node.attrs ?? {};
      if (Object.keys(attrs).some(key => !["colspan", "rowspan", "colwidth", "textAlign", "verticalAlign", "align"].includes(key))) throw new ContentValidationError("INVALID_TABLE", "单元格属性不受支持");
      for (const key of ["colspan", "rowspan"]) if (attrs[key] != null && attrs[key] !== 1) throw new ContentValidationError("INVALID_TABLE", "暂不支持合并单元格");
      if (attrs.colwidth != null && (!Array.isArray(attrs.colwidth) || attrs.colwidth.length !== 1 || attrs.colwidth.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 64 || value > 2000))) throw new ContentValidationError("INVALID_TABLE", "列宽必须为 64–2000 像素");
      for (const key of ["textAlign", "align"]) if (attrs[key] != null && !["left", "center", "right"].includes(String(attrs[key]))) throw new ContentValidationError("INVALID_TABLE", "水平对齐无效");
      if (attrs.verticalAlign != null && !["top", "middle", "bottom"].includes(String(attrs.verticalAlign))) throw new ContentValidationError("INVALID_TABLE", "垂直对齐无效");
    }
    if (node.type === "tableRow" && (node.content ?? []).some(child => child.type !== "tableCell" && child.type !== "tableHeader")) throw new ContentValidationError("INVALID_TABLE", "表格行必须包含单元格");
    if (node.marks) {
      for (const mark of node.marks) {
        if (!markNodes.has(mark.type)) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", `不支持的标记：${mark.type}`);
        if (mark.type === "textColor" || (mark.type === "highlight" && mark.attrs?.color != null)) {
          if (schemaVersion < SCHEMA_FEATURE.textColors) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "文本颜色需要新版客户端，请刷新页面");
          if (Object.keys(mark.attrs ?? {}).some(key => key !== "color") || !(mark.type === "textColor" ? isTextColor(mark.attrs?.color) : isHighlightColor(mark.attrs?.color))) throw new ContentValidationError("INVALID_COLOR", "文本颜色不受支持");
        }
        if (mark.type === "small") {
          if (schemaVersion < SCHEMA_FEATURE.richCells) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "小号文本需要新版客户端，请刷新页面");
          if (ancestors.includes("heading") || ancestors.includes("codeBlock") || node.marks.some(candidate => candidate.type === "code")) throw new ContentValidationError("INVALID_SMALL_TEXT", "标题和代码中不支持小号文本");
        }
        if (mark.type === "link" && !safeLink(mark.attrs?.href)) {
          throw new ContentValidationError("INVALID_LINK", "链接仅允许 http、https 或 mailto");
        }
      }
    }
    if (node.type === "fileAttachment") {
      if (schemaVersion < SCHEMA_FEATURE.fileAttachment) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "文件附件需要新版客户端");
      if (ancestors.some(type => type === "tableCell" || type === "tableHeader") && schemaVersion < SCHEMA_FEATURE.tableAttachments) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "表格附件需要新版客户端，请刷新页面");
      if (node.attrs?.display !== undefined && schemaVersion < SCHEMA_FEATURE.attachmentDisplay) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "附件展示样式需要新版客户端");
      const parsed = fileAttachmentAttributes.safeParse(node.attrs);
      if (!parsed.success || node.content !== undefined || node.marks !== undefined || !["doc", "blockquote", "listItem", "taskItem", "tableCell", "tableHeader"].includes(ancestors.at(-1) ?? "")) throw new ContentValidationError("INVALID_ATTACHMENT", "文件附件属性或位置无效");
      attachments.add(parsed.data.attachmentId); textParts.push(parsed.data.fileName, "\n"); return parsed.data.fileName;
    }
    if (node.type === "image") {
      const align = node.attrs?.imageAlign;
      if (align != null && (typeof align !== "string" || !["left", "center", "right"].includes(align))) throw new ContentValidationError("INVALID_ALIGNMENT", "图片对齐仅支持靠左、居中或靠右");
      if (align != null && schemaVersion < SCHEMA_FEATURE.imageAlignment) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "图片对齐需要新版客户端，请刷新页面");
      if (node.content?.length) throw new ContentValidationError("INVALID_ATTACHMENT", "图片节点不能包含子节点");
      const id = node.attrs?.attachmentId;
      const src = node.attrs?.src;
      if (typeof id !== "string" || typeof src !== "string" || src !== `/api/attachments/${id}`) {
        throw new ContentValidationError("INVALID_ATTACHMENT", "图片必须引用当前实例附件");
      }
      attachments.add(id);
      return "";
    }
    if (node.type === "noteLink") {
      if (schemaVersion < SCHEMA_FEATURE.noteLink) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "笔记互链需要新版客户端");
      const parsed = noteLinkAttributes.safeParse(node.attrs);
      if (!parsed.success || node.content !== undefined || node.marks !== undefined || ancestors.includes("codeBlock") || !["paragraph", "heading"].includes(ancestors.at(-1) ?? "")) throw new ContentValidationError("INVALID_NOTE_LINK", "笔记链接属性或位置无效");
      textParts.push(parsed.data.title); return parsed.data.title;
    }
    if (node.type === "label") {
      if (schemaVersion < SCHEMA_FEATURE.label) throw new ContentValidationError("UNSUPPORTED_CONTENT_SCHEMA", "标签需要新版客户端");
      const parsed = labelAttributes.safeParse(node.attrs);
      if (!parsed.success || node.content !== undefined || node.marks !== undefined || ancestors.includes("codeBlock") || !["paragraph", "heading"].includes(ancestors.at(-1) ?? "")) throw new ContentValidationError("INVALID_LABEL", "标签内容、颜色或位置无效");
      if (parsed.data.text !== node.attrs?.text) throw new ContentValidationError("INVALID_LABEL", "标签文字需要 NFC 规范化");
      textParts.push(parsed.data.text); return parsed.data.text;
    }
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new ContentValidationError("INVALID_CONTENT", "文本节点缺少内容");
      textParts.push(node.text);
      return node.text;
    }
    const own = (node.content ?? []).map((child) => walk(child, depth + 1, [...ancestors, node.type ?? ""])).join("");
    if (["paragraph", "heading", "blockquote", "codeBlock", "listItem", "taskItem", "tableCell", "tableHeader"].includes(node.type)) {
      paragraphs.push(own.trim());
      textParts.push("\n");
    }
    return own;
  };
  walk(input as ContentNode, 0);
  const nonEmpty = paragraphs.filter(Boolean);
  const title = (nonEmpty[0] ?? "").slice(0, 256);
  const snippet = (nonEmpty[1] ?? nonEmpty[0] ?? "").slice(0, 500);
  const plainText = textParts.join("").replace(/\n{3,}/g, "\n\n").trim();
  const normalizedTitle = normalizeSearch(title);
  const normalizedText = normalizeSearch(plainText);
  if (bytes(title) > 4096 || bytes(snippet) > 2048 || bytes(normalizedText) > MAX_SEARCH_BYTES) {
    throw new ContentValidationError("DERIVED_CONTENT_TOO_LARGE", "标题、摘要或搜索文本超过存储预算", 413);
  }
  return { serialized, title, snippet, plainText, normalizedTitle, normalizedText, charCount: Array.from(plainText).length, attachmentIds: [...attachments] };
}

export function validateSearchQuery(value: string): string {
  const trimmed = value.trim();
  if (Array.from(trimmed).length > 100) throw new ContentValidationError("QUERY_TOO_LONG", "搜索词最多 100 个字符");
  const normalized = normalizeSearch(trimmed);
  if (Array.from(normalized).length > 100) throw new ContentValidationError("QUERY_TOO_LONG", "规范化搜索词最多 100 个字符");
  return normalized;
}
