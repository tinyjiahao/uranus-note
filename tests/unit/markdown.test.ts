import { describe, expect, it } from "vitest";
import { markdownToContent } from "../../shared/markdown";
import { validateAndDeriveContent } from "../../shared/content";

describe("Markdown import", () => {
  it("converts headings, tasks, lists, quotes and code into valid content", () => {
    const content = markdownToContent("# 标题\n\n- [x] 完成\n- 项目\n> 引用\n```ts\nconst x = 1\n```");
    const derived = validateAndDeriveContent(content);
    expect(derived.title).toBe("标题");
    expect(derived.plainText).toContain("完成");
    expect(content.content?.map((node) => node.type)).toContain("codeBlock");
  });
});
