import { describe, expect, it } from "vitest";
import { ContentValidationError, normalizeSearch, validateAndDeriveContent, validateSearchQuery } from "../../shared/content";

describe("content validation and derivation", () => {
  it("derives title, snippet and normalized Chinese/ASCII search text", () => {
    const result = validateAndDeriveContent({ type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Ｔｅｓｔ 标题" }] },
      { type: "paragraph", content: [{ type: "text", text: "第二段 中文内容" }] },
    ] });
    expect(result.title).toBe("Ｔｅｓｔ 标题");
    expect(result.snippet).toBe("第二段 中文内容");
    expect(result.normalizedTitle).toContain("test 标题");
    expect(result.normalizedText).toContain("中文内容");
  });

  it("treats SQL wildcard characters as ordinary search text", () => {
    expect(validateSearchQuery("  %_O'Neil  ")).toBe("%_o'neil");
  });

  it("rejects unsafe links and unsupported nodes", () => {
    expect(() => validateAndDeriveContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] })).toThrowError(ContentValidationError);
    expect(() => validateAndDeriveContent({ type: "doc", content: [{ type: "script" }] })).toThrow(/不支持/);
  });

  it("normalizes without locale-specific behavior", () => {
    expect(normalizeSearch("ＡBC Café")).toBe("abc café");
  });

  it("accepts schema 5 table rich text and small marks without weakening rectangular tables", () => {
    const content = { type: "doc", content: [{ type: "table", content: [
      { type: "tableRow", content: [
        { type: "tableHeader", content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "引用", marks: [{ type: "small" }] }] }] }] },
        { type: "tableHeader", content: [{ type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] }] },
      ] },
      { type: "tableRow", content: [
        { type: "tableCell", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "项目" }] }] }] }] },
        { type: "tableCell", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "待办" }] }] }] }] },
      ] },
    ] }] };
    expect(validateAndDeriveContent(content, 5).plainText).toContain("待办");
    expect(() => validateAndDeriveContent(content, 4)).toThrow(/新版客户端/);
    expect(() => validateAndDeriveContent({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "小标题", marks: [{ type: "small" }] }] }] }, 5)).toThrow(/标题和代码/);
    expect(() => validateAndDeriveContent({ type: "doc", content: [{ type: "table", content: [
      { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] },
      { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }, { type: "tableCell", content: [{ type: "paragraph" }] }] },
    ] }] }, 5)).toThrow(/等长/);
  });

  it("enforces byte and structural complexity budgets", () => {
    const oversized = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "中".repeat(500_000) }] }] };
    expect(() => validateAndDeriveContent(oversized)).toThrowError(expect.objectContaining({ code: "CONTENT_TOO_LARGE", status: 413 }));
    let nested: Record<string, unknown> = { type: "paragraph" };
    for (let index = 0; index < 34; index++) nested = { type: "blockquote", content: [nested] };
    expect(() => validateAndDeriveContent({ type: "doc", content: [nested] })).toThrowError(expect.objectContaining({ code: "CONTENT_COMPLEXITY_EXCEEDED" }));
  });
});
