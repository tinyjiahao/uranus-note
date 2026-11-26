import { expect, it } from "vitest";
import { toMarkdown } from "../../shared/markdownExport";
import { markdownToContent } from "../../shared/markdown";
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
it("exports legacy imported Markdown tables without escaped separators or blank rows", () => {
  const source = "# Plan\n\n| 编号 | 需求 |\n\n| --- | --- |\n\n| V12 | **P0** `created_at` |\n\n1. **批次零**：修复";
  const result = toMarkdown(markdownToContent(source));
  expect(result).toContain("| 编号 | 需求 |\n| --- | --- |\n| V12 | **P0** `created_at` |");
  expect(result).toContain("1. **批次零**：修复");
  expect(result).not.toContain("\\|");
  expect(result).not.toContain("\\*");
});
it("preserves complete source marks while keeping unmatched characters and HTML escaped", () => {
  const result = toMarkdown({ type: "doc", content: [paragraph("Title"), paragraph("**bold** `a_b` ~~old~~ <script> unmatched * [x]")] });
  expect(result).toContain("**bold** `a_b` ~~old~~ \\<script\\> unmatched \\* \\[x\\]");
});
it("does not turn arbitrary pipe paragraphs into tables or alter code blocks", () => {
  const result = toMarkdown({ type: "doc", content: [paragraph("Title"), paragraph("| ordinary | text |"), paragraph("not a delimiter"), { type: "codeBlock", content: [{ type: "text", text: "**raw** \\|" }] }] });
  expect(result).toContain("\\| ordinary \\| text \\|");
  expect(result).toContain("```\n**raw** \\|\n```");
});

it("does not escape underscores inside identifiers", () => {
  expect(toMarkdown({ type: "doc", content: [paragraph("plan_v12.md"), paragraph("created_at DESC")] })).toBe("# plan_v12.md\n\ncreated_at DESC\n");
});
