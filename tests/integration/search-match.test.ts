import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createNote, listNotes } from "../../worker/services/notes";
import { uuidv7 } from "../../src/api/client";
it("returns bounded normalized page fragments with title priority and Unicode ranges", async () => {
  const folder = await env.DB.prepare("SELECT id FROM uranus_folders WHERE system_key='default'").first<{ id: number }>();
  const title = "ＵＸ😀匹配";
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 4, content: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: title }] },
    { type: "paragraph", content: [{ type: "text", text: "前😀".repeat(150) + "ＡＢＣ😀" + "后".repeat(300) }] },
  ] } });
  const result = await listNotes(env.DB, { folderId: folder!.id, q: "ａｂｃ😀", pageSize: 1 });
  const match = result.items[0]!.searchMatch!;
  expect(result.items[0]!.id).toBe(note.id); expect(match.source).toBe("body");
  expect(Array.from(match.text).length).toBeLessThanOrEqual(200);
  expect(match.before && match.after).toBe(true);
  expect(Array.from(match.text).slice(...match.ranges[0]!).join("")).toBe("abc😀");
  expect(result.items[0]).not.toHaveProperty("content");
  const byTitle = await listNotes(env.DB, { q: "ux😀" });
  expect(byTitle.items[0]!.searchMatch!.source).toBe("title");
  expect((await listNotes(env.DB, {})).items.every(item => !item.searchMatch)).toBe(true);
  expect((await listNotes(env.DB, { folderId: 999999, q: "abc😀" })).items).toHaveLength(0);
  const longQuery = "😀".repeat(100);
  await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 4, content: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "长查询" }] },
    { type: "paragraph", content: [{ type: "text", text: "前".repeat(201) + longQuery + "后".repeat(201) }] },
  ] } });
  const long = (await listNotes(env.DB, { q: longQuery })).items[0]!.searchMatch!;
  expect(Array.from(long.text)).toHaveLength(200);
  expect(Array.from(long.text).slice(...long.ranges[0]!).join("")).toBe(longQuery);
});
