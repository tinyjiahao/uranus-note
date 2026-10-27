import { expect, it } from "vitest";
import { validateAndDeriveContent } from "../../shared/content";
import { TEXT_COLORS, HIGHLIGHT_COLORS, parsePaletteColor } from "../../shared/textColors";
import { toMarkdown } from "../../shared/markdownExport";
import type { ContentNode } from "../../shared/dto";

const doc = (type: string, color?: unknown): ContentNode => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "彩色文字", marks: [{ type, ...(color === undefined ? {} : { attrs: { color } }) }] }] }] });
it("accepts the palette only in schema 11 and preserves legacy highlight", () => {
  for (const color of TEXT_COLORS) expect(validateAndDeriveContent(doc("textColor", color), 11).plainText).toBe("彩色文字");
  for (const color of HIGHLIGHT_COLORS) expect(validateAndDeriveContent(doc("highlight", color), 11).plainText).toBe("彩色文字");
  expect(() => validateAndDeriveContent(doc("textColor", TEXT_COLORS[0]), 10)).toThrow();
  expect(() => validateAndDeriveContent(doc("highlight", HIGHLIGHT_COLORS[0]), 10)).toThrow();
  expect(validateAndDeriveContent(doc("highlight"), 1).plainText).toBe("彩色文字");
  for (const color of ["red", "#123456", "url(https://example.com)", "#fff;position:fixed", null, 123]) {
    expect(() => validateAndDeriveContent(doc("textColor", color), 11)).toThrow();
  }
  expect(toMarkdown(doc("textColor", TEXT_COLORS[1]))).toContain("彩色文字");
  expect(parsePaletteColor("rgb(24, 88, 188)")).toBe("#1858bc");
  expect(parsePaletteColor("rgba(24, 88, 188, 0.5)")).toBeNull();
});
