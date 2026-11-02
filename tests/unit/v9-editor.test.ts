import { describe, expect, it } from "vitest";
import { validateAndDeriveContent } from "../../shared/content";
import type { ContentNode } from "../../shared/dto";
import { CODE_LANGUAGES, HIGHLIGHT_MAX_CHARS, highlightDecorations, looksLikeJson } from "../../src/components/editor/codeHighlight";
import { decodeDataImage, parseMarkdownPaste } from "../../src/components/editor/markdownPaste";

const doc = (blocks: ContentNode[]) => ({ type: "doc", content: blocks });
const nodes = (root: ContentNode): ContentNode[] => [root, ...(root.content ?? []).flatMap(nodes)];

describe("v9 Markdown paste", () => {
  it("converts common blocks and nested inline marks into valid schema-15 content", () => {
    const parsed = parseMarkdownPaste([
      "# 标题",
      "",
      "> 引用 **粗体和 *斜体***",
      "",
      "- [x] 完成",
      "- [ ] 待办",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 |",
      "",
      "```json",
      '{"ok":true}',
      "```",
    ].join("\n"));
    expect(parsed).not.toBeNull();
    expect(() => validateAndDeriveContent(doc(parsed!.blocks), 15)).not.toThrow();
    const all = nodes(doc(parsed!.blocks));
    expect(all.some(node => node.type === "taskList")).toBe(true);
    expect(all.some(node => node.type === "table")).toBe(true);
    expect(all.some(node => node.type === "codeBlock" && node.attrs?.language === "json")).toBe(true);
    expect(all.some(node => node.marks?.some(mark => mark.type === "bold") && node.marks?.some(mark => mark.type === "italic"))).toBe(true);
    const table = all.find(node => node.type === "table")!;
    expect(table.content?.map(row => row.content?.length)).toEqual([2, 2]);
  });

  it("keeps guards and degrades relative images/links to literal safe text", () => {
    expect(parseMarkdownPaste("https://example.com\n第二行")).toBeNull();
    expect(parseMarkdownPaste('{"a":1}\n{"b":2}')).toBeNull();
    expect(parseMarkdownPaste("**单行**")).toBeNull();
    const parsed = parseMarkdownPaste("# 标题\n\n![图](images/a.png) 与 [文件](attachments/a.pdf)")!;
    expect(validateAndDeriveContent(doc(parsed.blocks), 15).plainText).toContain("[图](images/a.png)");
    expect(validateAndDeriveContent(doc(parsed.blocks), 15).plainText).toContain("[文件](attachments/a.pdf)");
    expect(nodes(doc(parsed.blocks)).some(node => node.marks?.some(mark => mark.type === "link"))).toBe(false);
  });

  it("keeps a lone pipe-delimited line as text instead of treating it as a table", () => {
    const parsed = parseMarkdownPaste("# 标题\n| 不是表格 |\n后续文本");
    expect(parsed?.blocks).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
      { type: "paragraph", content: [{ type: "text", text: "| 不是表格 | 后续文本" }] },
    ]);
  });

  it("decodes bounded data images and validates pending-image structure before insertion", () => {
    const source = "data:image/png;base64," + btoa("tiny");
    expect(decodeDataImage(source)).toMatchObject({ size: 4, type: "image/png" });
    const parsed = parseMarkdownPaste(`# 标题\n\n![图](${source})`)!;
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.blocks.flatMap(nodes).some(node => node.attrs?.pending === 0)).toBe(true);
    expect(decodeDataImage(`data:image/png;base64,${"A".repeat(13_333_340)}`)).toBeNull();
  });
});

describe("v9 code highlighting", () => {
  it("registers only the planned language set and highlights aliases and inferred JSON", () => {
    expect(CODE_LANGUAGES.map(item => item.id)).toEqual(["text", "json", "javascript", "typescript", "xml", "css", "python", "bash", "sql", "yaml"]);
    expect(looksLikeJson("  [1, 2]")).toBe(true);
    expect(looksLikeJson("const x = 1")).toBe(false);
    expect(highlightDecorations("json", '{"ok":true}', 1).length).toBeGreaterThan(0);
    expect(highlightDecorations("tsx", "const A = () => <div />", 1).length).toBeGreaterThan(0);
    expect(highlightDecorations("not-registered", "plain", 1)).toEqual([]);
    expect(HIGHLIGHT_MAX_CHARS).toBe(50_000);
  });
});
