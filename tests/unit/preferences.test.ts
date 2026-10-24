import { expect, it } from "vitest";
import { defaultSort, noteTime, parseSort, useUiStore } from "../../src/state/ui";

it("uses validated preference defaults and tolerates unavailable browser storage", () => {
  for (const value of [null, "broken", '{}', '{"by":"title;select","dir":"desc"}', '{"by":"title","dir":"sideways"}']) expect(parseSort(value)).toEqual(defaultSort);
  expect(parseSort('{"by":"title","dir":"asc"}')).toEqual({ by: "title", dir: "asc" });
  useUiStore.getState().setWidthMode("reading");
  expect(useUiStore.getState().widthMode).toBe("reading");
  expect(useUiStore.getState().storageWarning).toBe(true);
});
it("formats today and yesterday using local calendar days", () => {
  const now = new Date(2026, 9, 24, 12);
  expect(noteTime(new Date(2026, 9, 24, 3).getTime(), now)).toContain("今天");
  expect(noteTime(new Date(2026, 9, 23, 23).getTime(), now)).toContain("昨天");
  expect(noteTime(new Date(2026, 8, 1).getTime(), now)).not.toMatch(/今天|昨天/);
});
