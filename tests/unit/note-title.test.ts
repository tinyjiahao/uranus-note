import { describe, expect, it } from "vitest";
import { joinNoteTitle, splitNoteTitle, titleText, updateTitle } from "../../src/components/editor/noteTitle";
import type { ContentNode } from "../../shared/dto";

describe("title view split", () => {
  it("round trips a formatted heading and preserves the rest of the document", () => {
    const doc: ContentNode = { type: "doc", content: [
      { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "旧标题", marks: [{ type: "bold" }] }] },
      { type: "table", content: [] }, { type: "paragraph" },
    ] };
    const parts = splitNoteTitle(doc);
    expect(titleText(parts.title)).toBe("旧标题");
    expect(joinNoteTitle(parts.title, parts.body)).toEqual(doc);
    const changed = updateTitle(parts.title, "旧标题追加");
    expect(changed.attrs).toEqual(parts.title.attrs);
    expect(changed.content?.[0]).toEqual(parts.title.content?.[0]);
    expect(titleText(changed)).toBe("旧标题追加");
  });
  it("does not take a title out of a table or list", () => {
    for (const type of ["table", "bulletList", "image", "codeBlock"]) {
      const doc: ContentNode = { type: "doc", content: [{ type }] };
      const parts = splitNoteTitle(doc);
      expect(titleText(parts.title)).toBe("");
      expect(parts.body).toEqual(doc);
      expect(joinNoteTitle(updateTitle(parts.title, "新标题"), parts.body).content?.[1]).toEqual(doc.content?.[0]);
    }
  });
  it("keeps an empty title separate from the first body paragraph after reload", () => {
    const title = { type: "paragraph" };
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }] };
    const parts = splitNoteTitle(joinNoteTitle(title, body));
    expect(titleText(parts.title)).toBe("");
    expect(parts.body).toEqual(body);
  });
  it("handles multiline titles, deletion and emoji without losing body data", () => {
    let title: ContentNode = { type: "paragraph" };
    title = updateTitle(title, "标题😀\n第二行");
    expect(titleText(title)).toBe("标题😀\n第二行");
    title = updateTitle(title, "标题😃\n第二行");
    expect(titleText(title)).toBe("标题😃\n第二行");
    expect(titleText(updateTitle(title, ""))).toBe("");
  });
});
