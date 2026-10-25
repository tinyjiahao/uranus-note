import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listNotes, createNote, patchNote, createManualVersion, restoreVersion, getNote } from "../../worker/services/notes";
import { uuidv7 } from "../../src/api/client";
import { validateAndDeriveContent } from "../../shared/content";

const table = (width = 180) => ({ type: "doc", content: [{ type: "table", attrs: { widthMode: "fixed" }, content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth: [width], textAlign: "center", verticalAlign: "bottom" }, content: [{ type: "paragraph" }] }] }] }] });
describe("v2 content and full-result ordering", () => {
  it("round trips table attributes, rejects obsolete clients and restores old/new versions", async () => {
    const old = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 1 });
    const oldVersion = await createManualVersion(env.DB, old.id, uuidv7());
    const first = await patchNote(env.DB, old.id, { operation_id: uuidv7(), expected_revision: 1, content_schema_version: 2, content: table() });
    expect(first.note.contentSchemaVersion).toBe(2);
    expect(first.note.content).toEqual(table());
    const version = await createManualVersion(env.DB, old.id, uuidv7());
    await expect(patchNote(env.DB, old.id, { operation_id: uuidv7(), expected_revision: 2, content_schema_version: 1, content: table(200) })).rejects.toMatchObject({ code: "CLIENT_UPDATE_REQUIRED" });
    expect((await getNote(env.DB, old.id)).revision).toBe(2);
    const restored = await restoreVersion(env.DB, old.id, Number(oldVersion.id), { operation_id: uuidv7(), expected_revision: 2 });
    expect(restored.contentSchemaVersion).toBe(2);
    const again = await restoreVersion(env.DB, old.id, Number(version.id), { operation_id: uuidv7(), expected_revision: restored.revision });
    expect(again.content).toEqual(table());
  });
  it("validates numeric widths and enum-only alignments", () => {
    for (const value of [-1, 0, 63, 2001, NaN, Infinity]) expect(() => validateAndDeriveContent(table(value))).toThrow();
    expect(() => validateAndDeriveContent(table(64))).not.toThrow();
    expect(() => validateAndDeriveContent(table(2000))).not.toThrow();
    const bad = table(); bad.content[0]!.content[0]!.content[0]!.attrs.textAlign = "left;color:red";
    expect(() => validateAndDeriveContent(bad)).toThrow();
  });
  it("sorts 150 notes globally with stable ids and title-only empty-last semantics", async () => {
    await env.DB.prepare("INSERT INTO uranus_folders(id,name,created_at,updated_at) VALUES(42,'v2-sort',1,1)").run();
    const data = Array.from({ length: 150 }, (_, i) => ({ id: 50000 + i, title: ["", "alpha", "中文", "beta", "alpha"][i % 5]!, created_at: i % 3, updated_at: i % 7, pinned: i % 11 === 0 ? 1 : 0 }));
    await env.DB.batch(data.map(n => env.DB.prepare("INSERT INTO uranus_notes(id,folder_id,title,content_json,last_operation_id,created_at,updated_at,pinned) VALUES(?,42,?,'{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}','seed',?,?,?)").bind(n.id, n.title, n.created_at, n.updated_at, n.pinned)));
    await env.DB.batch(data.map(n => env.DB.prepare("INSERT INTO uranus_note_search VALUES(?,?,?,1)").bind(n.id, n.title, "needle")));
    for (const by of ["created_at", "updated_at", "title"] as const) for (const dir of ["asc", "desc"] as const) {
      const expected = [...data].sort((a, b) => b.pinned - a.pinned || (by === "title" ? Number(a.title === "") - Number(b.title === "") : 0) || (a[by] < b[by] ? -1 : a[by] > b[by] ? 1 : 0) * (dir === "asc" ? 1 : -1) || a.id - b.id);
      const ids: number[] = [];
      for (let page = 1; page <= 3; page++) {
        const result = await listNotes(env.DB, { folderId: 42, q: "needle", sortBy: by, sortDir: dir, page, pageSize: 50 });
        expect(result.hasMore).toBe(page < 3); ids.push(...result.items.map(n => n.id));
      }
      expect(ids).toEqual(expected.map(n => n.id)); expect(new Set(ids).size).toBe(150);
    }
    await expect(listNotes(env.DB, { sortBy: "title; DROP TABLE uranus_notes" })).rejects.toMatchObject({ code: "INVALID_SORT" });
    const largePage = await listNotes(env.DB, { folderId: 42, q: "needle", pageSize: 100 });
    expect(largePage.items).toHaveLength(100);
    expect(largePage.items.every(item => item.searchMatch?.text === "needle")).toBe(true);
    await expect(listNotes(env.DB, { page: NaN })).rejects.toMatchObject({ code: "INVALID_PAGE" });
  });
});
