import { beforeEach, expect, it, vi } from "vitest";
import { filterTitles, loadTitleIndex, resolveLinkTitles } from "../../src/state/noteTitles";
import { listNotes } from "../../src/api/client";
import { activateIdentity } from "../../src/state/identity";
vi.mock("../../src/api/client", () => ({ listNotes: vi.fn() }));
const list = vi.mocked(listNotes);
beforeEach(() => { list.mockReset(); activateIdentity("titles-a"); });
const response = (items: {id: number; title: string}[], hasMore = false) => ({ items, hasMore }) as Awaited<ReturnType<typeof listNotes>>;
it("normalizes Chinese/English titles and bounds suggestions", () => {
  expect(filterTitles([{ id: 1, title: "中文 ABC" }, { id: 2, title: "other" }], " abc ").map(x => x.id)).toEqual([1]);
  expect(filterTitles([{ id: 1, title: "中文 ABC" }], "中文")).toHaveLength(1);
  expect(filterTitles(Array.from({ length: 70 }, (_, id) => ({ id, title: "title" })), "")).toHaveLength(50);
});
it("loads minimal records, deduplicates pagination and stops at 50 pages", async () => {
  list.mockResolvedValue(response([{ id: 1, title: "one" }], true));
  const index = await loadTitleIndex(new AbortController().signal);
  expect(list).toHaveBeenCalledTimes(50);
  expect(index).toEqual({ items: [{ id: 1, title: "one" }], complete: false });
});
it("rejects a previous account's late index response", async () => {
  list.mockImplementation(async () => { activateIdentity("titles-b"); return response([{ id: 1, title: "private" }]); });
  await expect(loadTitleIndex(new AbortController().signal)).rejects.toThrow("Cancelled");
});
it("reuses indexed titles and batches remaining IDs at the API's actual limit", async () => {
  list.mockImplementation(async filters => response(filters!.ids!.map(id => ({ id, title: String(id) }))));
  const ids = Array.from({ length: 43 }, (_, i) => i + 1);
  const titles = await resolveLinkTitles(ids, new AbortController().signal, { complete: true, items: [{ id: 1, title: "cached" }] });
  expect(titles).toHaveLength(43);
  expect(list.mock.calls.map(call => call[0]?.ids?.length)).toEqual([20, 20, 2]);
  expect(titles[0]?.title).toBe("cached");
});
it("leaves absent targets missing and surfaces request failures", async () => {
  list.mockResolvedValue(response([]));
  expect(await resolveLinkTitles([7], new AbortController().signal)).toEqual([]);
  list.mockRejectedValue(new Error("failed"));
  await expect(loadTitleIndex(new AbortController().signal)).rejects.toThrow("failed");
});

it("excludes the current ID before the limit without removing other identical titles", () => {
  const items = Array.from({ length: 51 }, (_, id) => ({ id: id + 1, title: "same" }));
  const matches = filterTitles(items, "same", 1);
  expect(matches).toHaveLength(50);
  expect(matches.map(item => item.id)).not.toContain(1);
  expect(matches.at(-1)?.id).toBe(51);
  expect(filterTitles(items, "", 1)).toEqual(matches);
});
