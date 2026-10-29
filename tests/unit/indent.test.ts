import { expect, it } from "vitest";
import type { ContentNode } from "../../shared/dto";
import { validateAndDeriveContent } from "../../shared/content";

const doc = (...content: ContentNode[]): ContentNode => ({ type: "doc", content });
const paragraph = (indent: unknown, type = "paragraph"): ContentNode => ({ type, attrs: { ...(type === "heading" ? { level: 2 } : {}), indent }, content: [{ type: "text", text: "缩进" }] });

it("accepts indent levels 1–6 on paragraphs and headings from schema 13", () => {
  for (const level of [1, 3, 6]) {
    expect(validateAndDeriveContent(doc(paragraph(level)), 13).plainText).toBe("缩进");
    expect(validateAndDeriveContent(doc(paragraph(level, "heading")), 13).plainText).toBe("缩进");
  }
});

it("treats missing, null and zero as no indent in every schema", () => {
  for (const value of [undefined, null, 0]) expect(() => validateAndDeriveContent(doc(paragraph(value)), 12)).not.toThrow();
});

it("rejects indents from older clients and invalid values", () => {
  expect(() => validateAndDeriveContent(doc(paragraph(2)), 12)).toThrow(/新版客户端/);
  for (const value of [-1, 7, 1.5, "2", NaN]) expect(() => validateAndDeriveContent(doc(paragraph(value)), 13)).toThrow(/1–6/);
});

it("accepts a persisted code block collapsed flag only from schema 14 and only as a boolean", () => {
  const code = (collapsed: unknown): ContentNode => ({ type: "codeBlock", attrs: { language: null, collapsed }, content: [{ type: "text", text: "a\nb" }] });
  expect(() => validateAndDeriveContent(doc(code(true)), 14)).not.toThrow();
  for (const value of [undefined, null, false]) expect(() => validateAndDeriveContent(doc(code(value)), 13)).not.toThrow();
  expect(() => validateAndDeriveContent(doc(code(true)), 13)).toThrow(/新版客户端/);
  for (const value of ["true", 1, {}]) expect(() => validateAndDeriveContent(doc(code(value)), 14)).toThrow(/布尔值/);
});
