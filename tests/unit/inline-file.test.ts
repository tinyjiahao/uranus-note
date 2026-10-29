import { expect, it } from "vitest";
import { validateAndDeriveContent } from "../../shared/content";
import { toMarkdown } from "../../shared/markdownExport";
import type { ContentNode } from "../../shared/dto";

const file = (extra: Record<string, unknown> = {}): ContentNode => ({ type: "inlineFile", attrs: { attachmentId: "abc123", fileName: "说明.txt", size: 12, mime: "text/plain", ...extra } });
const paragraph = (...content: ContentNode[]): ContentNode => ({ type: "paragraph", content });
const doc = (...content: ContentNode[]): ContentNode => ({ type: "doc", content });
const text = (value: string): ContentNode => ({ type: "text", text: value });

it("accepts inline files inside paragraphs and table cell paragraphs from schema 15, collecting attachments and text", () => {
  const derived = validateAndDeriveContent(doc(paragraph(text("前"), file(), text("后"))), 15);
  expect(derived.attachmentIds).toContain("abc123");
  expect(derived.plainText).toContain("说明.txt");
  const cell = { type: "tableCell", content: [paragraph(file())] } as ContentNode;
  const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("H"))] }] }, { type: "tableRow", content: [cell] }] } as ContentNode;
  expect(() => validateAndDeriveContent(doc(table), 15)).not.toThrow();
});

it("rejects inline files below schema 15, outside paragraphs, with extra attributes or image mime", () => {
  expect(() => validateAndDeriveContent(doc(paragraph(file())), 14)).toThrow(/新版客户端/);
  expect(() => validateAndDeriveContent(doc({ type: "heading", attrs: { level: 1 }, content: [file()] }), 15)).toThrow(/位置无效|属性/);
  expect(() => validateAndDeriveContent(doc(paragraph(file({ display: "card" }))), 15)).toThrow();
  expect(() => validateAndDeriveContent(doc(paragraph(file({ mime: "image/png" }))), 15)).toThrow();
});

it("exports inline files as links to the packaged attachment", () => {
  const markdown = toMarkdown(doc(paragraph(text("标题")), paragraph(text("见 "), file())));
  expect(markdown).toContain("说明.txt");
});
