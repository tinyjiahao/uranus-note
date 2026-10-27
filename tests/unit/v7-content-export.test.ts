import { expect, it } from "vitest";
import { validateAndDeriveContent } from "../../shared/content";
import type { ContentNode } from "../../shared/dto";
import { attachmentFiles, safeFileName, toMarkdown } from "../../shared/markdownExport";
import { isMagicValid } from "../../shared/files";
import { crc32, StoreZip } from "../../shared/zip";
import { splitNoteTitle } from "../../src/components/editor/noteTitle";
import { LABEL_COLORS, labelAttributes } from "../../shared/label";

const text = (value: string): ContentNode => ({ type: "text", text: value });
const paragraph = (...content: ContentNode[]): ContentNode => ({ type: "paragraph", content });
const doc = (...content: ContentNode[]): ContentNode => ({ type: "doc", content });
const label: ContentNode = { type: "label", attrs: { text: "重点", color: "blue" } };
it("validates labels, budgets, search and non-text title projection", () => {
  for (const color of LABEL_COLORS) expect(validateAndDeriveContent(doc(paragraph({ ...label, attrs: { ...label.attrs, color } })), 6).plainText).toBe("重点");
  expect(validateAndDeriveContent(doc(paragraph(label)), 6)).toMatchObject({ normalizedText: "重点", charCount: 2, attachmentIds: [] });
  expect(splitNoteTitle(doc(paragraph(label))).body.content).toEqual([paragraph(label)]);
  expect(labelAttributes.parse({ text: "e\u0301", color: "gray" }).text).toBe("é");
  for (const node of [{ ...label, attrs: { text: "x", color: "#fff" } }, { ...label, attrs: { text: "x".repeat(51), color: "blue" } }, { ...label, attrs: { text: "a\nb", color: "blue" } }, { ...label, content: [] }, { ...label, marks: [] }]) expect(() => validateAndDeriveContent(doc(paragraph(node)))).toThrow();
  expect(() => validateAndDeriveContent(doc({ type: "codeBlock", content: [label] }))).toThrow();
  expect(() => validateAndDeriveContent(doc(paragraph(label)), 5)).toThrow();
  expect(() => validateAndDeriveContent(doc(paragraph(text("future"))), 99)).toThrow();
});
it("validates versioned file and note link nodes without requiring a live target", () => {
  const file: ContentNode = { type: "fileAttachment", attrs: { attachmentId: "a", fileName: "a.pdf", size: 4, mime: "application/pdf" } };
  expect(validateAndDeriveContent(doc(file), 7)).toMatchObject({ plainText: "a.pdf", attachmentIds: ["a"] });
  expect(() => validateAndDeriveContent(doc(file), 6)).toThrow();
  expect(() => validateAndDeriveContent(doc({ ...file, attrs: { ...file.attrs, size: 10_000_001 } }))).toThrow();
  const link: ContentNode = { type: "noteLink", attrs: { noteId: 123, title: "关联标题" } };
  expect(validateAndDeriveContent(doc(paragraph(link)), 8).plainText).toBe("关联标题");
  expect(() => validateAndDeriveContent(doc(paragraph(link)), 7)).toThrow();
  for (const noteId of [0, -1, 1.5, "123", Infinity]) expect(() => validateAndDeriveContent(doc(paragraph({ ...link, attrs: { ...link.attrs, noteId } })))).toThrow();
  expect(toMarkdown(doc(paragraph(link), file))).toContain("[[关联标题]]");
});
it("exports nodes and marks with explicit safe Markdown degradation", () => {
  const content = doc(paragraph(text("A | [title]")),
    { type: "heading", attrs: { level: 2 }, content: [text("Section")] },
    paragraph({ ...text("bold"), marks: [{ type: "bold" }] }, text(" "), { ...text("italic"), marks: [{ type: "italic" }] }, { ...text("gone"), marks: [{ type: "strike" }] }, { ...text("plain"), marks: [{ type: "underline" }, { type: "highlight" }, { type: "small" }] }, { type: "hardBreak" }, label),
    paragraph({ ...text("a`b"), marks: [{ type: "code" }] }, { ...text("link"), marks: [{ type: "link", attrs: { href: "https://example.com/a(b)" } }] }),
    { type: "codeBlock", attrs: { language: "js" }, content: [text("```\nx")] },
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("item"))] }] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [paragraph(text("third"))] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("done"))] }, { type: "taskItem", content: [paragraph(text("todo"))] }] },
    { type: "blockquote", content: [paragraph(text("quote"))] }, { type: "horizontalRule" },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("a|b")), paragraph(text("c"))] }] }] },
    { type: "image", attrs: { attachmentId: "id1", alt: "same.png" } }, { type: "image", attrs: { attachmentId: "id2", alt: "same.png" } });
  expect(toMarkdown(content)).toMatchSnapshot();
  expect(new Set(attachmentFiles(content).values()).size).toBe(2);
  expect(safeFileName("../a\\b:?.", "fallback")).toBe("_a_b__");
  expect(toMarkdown(doc())).toBe("\n");
  expect(toMarkdown(doc({ type: "image", attrs: { attachmentId: "a", alt: "a#%.png" } }))).toContain("attachments/a%23%25-a.png");
  expect(new TextEncoder().encode(safeFileName("文".repeat(100), "empty")).length).toBeLessThanOrEqual(180);
  expect(safeFileName("CON", "empty")).toBe("_CON");
});
it("checks full file bytes including invalid UTF-8 and NUL after the signature window", () => {
  for (const mime of ["text/plain", "text/markdown", "text/csv"]) {
    expect(isMagicValid(mime, new TextEncoder().encode("中文\nhello"))).toBe(true);
    expect(isMagicValid(mime, new TextEncoder().encode("a".repeat(100) + "\0"))).toBe(false);
    expect(isMagicValid(mime, new Uint8Array([0xc3, 0x28]))).toBe(false);
  }
  expect(isMagicValid("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
  expect(isMagicValid("application/pdf", new TextEncoder().encode("<html>"))).toBe(false);
  expect(isMagicValid("application/zip", new Uint8Array([80,75,3,4]))).toBe(true);
  expect(isMagicValid("text/html", new TextEncoder().encode("<html>"))).toBe(false);
});
it("writes valid store-only ZIP headers, CRC, UTF-8 paths and rejects traversal/duplicates/budget", async () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  const zip = new StoreZip(), data = new TextEncoder().encode("正文"); zip.add("笔记.md", data); zip.add("attachments/x.txt", data);
  const bytes = new Uint8Array(await zip.blob().arrayBuffer()), view = new DataView(bytes.buffer), end = bytes.length - 22;
  expect(view.getUint32(0, true)).toBe(0x04034b50); expect(view.getUint16(6, true)).toBe(0x0800); expect(view.getUint16(8, true)).toBe(0);
  expect(view.getUint32(14, true)).toBe(crc32(data));
  expect(view.getUint32(end, true)).toBe(0x06054b50); expect(view.getUint16(end + 10, true)).toBe(2);
  const central = view.getUint32(end + 16, true); expect(view.getUint32(central, true)).toBe(0x02014b50);
  expect(() => zip.add("../bad", data)).toThrow(); expect(() => zip.add("笔记.md", data)).toThrow();
  expect(() => zip.add("large", new Uint8Array(100_000_000))).toThrow();
});
