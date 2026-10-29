import { expect, it } from "vitest";
import { validateAndDeriveContent } from "../../shared/content";
import type { ContentNode } from "../../shared/dto";
import { toMarkdown, attachmentFiles } from "../../shared/markdownExport";

const image = (id: string, extra: Record<string, unknown> = {}): ContentNode => ({ type: "inlineImage", attrs: { attachmentId: id, src: `/api/attachments/${id}`, alt: `${id}.png`, ...extra } });
const paragraph = (...content: ContentNode[]): ContentNode => ({ type: "paragraph", content });
const doc = (...content: ContentNode[]): ContentNode => ({ type: "doc", content });

it("accepts several inline images in one paragraph from schema 12 and collects their attachments", () => {
  const content = doc(paragraph({ type: "text", text: "对比" }), paragraph(image("a1"), image("b2", { width: 240 }), { type: "text", text: " 说明" }));
  expect(validateAndDeriveContent(content, 12).attachmentIds).toEqual(["a1", "b2"]);
  expect(() => validateAndDeriveContent(content, 11)).toThrow(/新版客户端/);
});

it("rejects inline images outside paragraphs, with bad sources or out-of-range widths", () => {
  expect(() => validateAndDeriveContent(doc({ type: "heading", attrs: { level: 2 }, content: [image("a1")] }), 12)).toThrow();
  expect(() => validateAndDeriveContent(doc(paragraph(image("a1", { src: "https://example.com/x.png" }))), 12)).toThrow();
  expect(() => validateAndDeriveContent(doc(paragraph(image("a1", { width: 10 }))), 12)).toThrow();
  expect(() => validateAndDeriveContent(doc(paragraph(image("a1", { width: 5000 }))), 12)).toThrow();
});

it("allows inline images in table cell paragraphs and exports them to Markdown", () => {
  const table: ContentNode = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(image("a1"), image("b2"))] }] }] };
  expect(validateAndDeriveContent(doc(table), 12).attachmentIds).toEqual(["a1", "b2"]);
  const content = doc(paragraph({ type: "text", text: "标题" }), paragraph(image("a1"), image("b2")));
  expect(attachmentFiles(content).size).toBe(2);
  expect(toMarkdown(content)).toContain("![a1.png](");
});
