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

  it("enforces byte and structural complexity budgets", () => {
    const oversized = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "中".repeat(500_000) }] }] };
    expect(() => validateAndDeriveContent(oversized)).toThrowError(expect.objectContaining({ code: "CONTENT_TOO_LARGE", status: 413 }));
    let nested: Record<string, unknown> = { type: "paragraph" };
    for (let index = 0; index < 34; index++) nested = { type: "blockquote", content: [nested] };
    expect(() => validateAndDeriveContent({ type: "doc", content: [nested] })).toThrowError(expect.objectContaining({ code: "CONTENT_COMPLEXITY_EXCEEDED" }));
  });
});
