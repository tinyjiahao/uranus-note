import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createNote, createManualVersion, listVersions, patchNote, restoreVersion } from "../../worker/services/notes";
import { uuidv7 } from "../../src/api/client";
const content = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
async function seed() {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 1, content: content("current") });
  await env.DB.prepare("DELETE FROM uranus_note_versions WHERE note_id=?").bind(note.id).run();
  const base = Date.now() - 1_000_000;
  // IDs deliberately run opposite to creation time.
  const ids = Array.from({ length: 31 }, (_, i) => note.id - i - 1);
  await env.DB.batch(ids.map((id, i) => env.DB.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES (?,?,?,1,1,?,1,1,?)").bind(id, note.id, JSON.stringify(content(`version-${i}`)), `version-${i}`, base + i * 1000)));
  return { note, ids };
}
it("orders versions by creation time with deterministic ties and pagination", async () => {
  const { note, ids } = await seed();
  const result = await listVersions(env.DB, note.id, 1, 10);
  expect(result.items.map(item => item.id)).toEqual(ids.slice(21).reverse());
  await env.DB.prepare("UPDATE uranus_note_versions SET created_at=? WHERE id IN (?,?)").bind(Date.now(), ids[0], ids[1]).run();
  expect((await listVersions(env.DB, note.id, 1, 2)).items.map(item => item.id)).toEqual(ids.slice(0, 2));
});
it.each(["save", "manual", "restore"])("retains the newest 30 versions on %s", async kind => {
  const { note, ids } = await seed();
  if (kind === "save") await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content: content("saved") });
  if (kind === "manual") await createManualVersion(env.DB, note.id, uuidv7());
  if (kind === "restore") await restoreVersion(env.DB, note.id, ids[30]!, { operation_id: uuidv7(), expected_revision: note.revision });
  const rows = await env.DB.prepare("SELECT id FROM uranus_note_versions WHERE note_id=?").bind(note.id).all<{ id: number }>();
  expect(rows.results).toHaveLength(30);
  expect(rows.results.map(row => row.id)).not.toContain(ids[0]);
  expect(rows.results.map(row => row.id)).not.toContain(ids[1]);
  expect(rows.results.map(row => row.id)).toContain(ids[30]);
});
it("deduplicates manual snapshots against the newest timestamp, not largest ID", async () => {
  const { note, ids } = await seed();
  await env.DB.prepare("UPDATE uranus_note_versions SET content_json=? WHERE id=?").bind(JSON.stringify(note.content), ids[30]).run();
  expect((await createManualVersion(env.DB, note.id, uuidv7())).id).toBe(ids[30]);
});
