import { expect, it } from "vitest";
import type { ContentNode } from "../../shared/dto";
import { computeContentStats, formatBytes } from "../../shared/noteStats";

const text = (value: string, ...marks: string[]): ContentNode => ({ type: "text", text: value, ...(marks.length ? { marks: marks.map(type => ({ type, attrs: { href: "https://example.com" } })) } : {}) });

it("counts characters, words, structure and tasks", () => {
  const doc: ContentNode = { type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [text("标题")] },
    { type: "paragraph", content: [text("Hello brave world "), text("link", "link"), { type: "label", attrs: { text: "标签", color: "blue" } }] },
    { type: "paragraph" },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [text("done")] }] }, { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [text("todo")] }] }] },
    { type: "paragraph", content: [{ type: "inlineImage", attrs: { attachmentId: "a", src: "/api/attachments/a" } }, { type: "inlineImage", attrs: { attachmentId: "b", src: "/api/attachments/b" } }] },
    { type: "codeBlock", content: [text("x = 1")] },
  ] };
  const stats = computeContentStats(doc);
  expect(stats).toMatchObject({ headings: 1, images: 2, links: 1, labels: 1, codeBlocks: 1, tasks: { done: 1, total: 2 } });
  expect(stats.words).toBe(12);
  expect(stats.charactersNoSpace).toBeLessThan(stats.characters);
  expect(stats.readingMinutes).toBe(1);
  expect(stats.bytes).toBe(new TextEncoder().encode(JSON.stringify(doc)).length);
});

it("reports empty documents and formats sizes", () => {
  const stats = computeContentStats({ type: "doc", content: [{ type: "paragraph" }] });
  expect(stats).toMatchObject({ characters: 0, words: 0, readingMinutes: 0, paragraphs: 0 });
  expect([0, 1023, 1024, 1536, 10 * 1024 * 1024].map(formatBytes)).toEqual(["0 B", "1023 B", "1.00 KB", "1.50 KB", "10.0 MB"]);
});

it("counts continuous links once across formatting and separates blocks and gaps", () => {
  expect(computeContentStats({ type: "doc", content: [
    { type: "paragraph", content: [text("one", "link"), text("bold", "link", "bold"), text(" gap "), text("two", "link")] },
    { type: "paragraph", content: [text("three", "link")] },
  ] }).links).toBe(3);
});
