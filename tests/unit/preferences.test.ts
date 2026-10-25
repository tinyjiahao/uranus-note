import { expect, it } from "vitest";
import { defaultSort, noteTime, parseSort, parseEditorFontSize, useUiStore } from "../../src/state/ui";

it("validates font-size preferences and updates even when storage is unavailable", () => {
  for (const value of [null, "", "NaN", "15", "100", "14px", "-1"]) expect(parseEditorFontSize(value)).toBe(14);
  for (const size of [14, 16, 18, 20]) expect(parseEditorFontSize(String(size))).toBe(size);
  useUiStore.getState().setEditorFontSize(20);
  expect(useUiStore.getState().editorFontSize).toBe(20);
  expect(useUiStore.getState().storageWarning).toBe(true);
});

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
