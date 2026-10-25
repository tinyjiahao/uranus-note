import { describe, expect, it } from "vitest";
import { searchMatch } from "../../shared/searchMatch";
describe("bounded code-point search fragments", () => {
  it("keeps emoji offsets and repeated literal matches correct", () => {
    const hit = searchMatch("body", "😀前abc😀abc后", "abc");
    expect(hit.ranges).toEqual([[2, 5], [6, 9]]);
    for (const [start, end] of hit.ranges) expect(Array.from(hit.text).slice(start, end).join("")).toBe("abc");
  });
  it("never emits HTML or more than 200 code points", () => {
    const hit = searchMatch("body", "<script>" + "😀".repeat(250), "<script>");
    expect(Array.from(hit.text)).toHaveLength(200);
    expect(hit.ranges).toEqual([[0, 8]]);
    expect(searchMatch("title", "abc", "").ranges).toEqual([]);
  });
});
