import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createManualVersion, createNote, getVersion, patchNote, restoreVersion } from "../../worker/services/notes";
import { uuidv7 } from "../../src/api/client";

const rich = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [
  { type: "tableCell", content: [{ type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "small", marks: [{ type: "small" }] }] }] }] }] },
] }] }] };

it("persists schema 5, protects it from old clients, and restores schema 5 history", async () => {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 4 });
  const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: 5, content: rich });
  expect(saved.note.contentSchemaVersion).toBe(5);
  expect(saved.note.content).toEqual(rich);
  const version = await createManualVersion(env.DB, note.id, uuidv7());
  expect(Number((await getVersion(env.DB, note.id, Number(version.id)) as Record<string, unknown>).content_schema_version)).toBe(5);
  await expect(patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 4, content: { type: "doc", content: [{ type: "paragraph" }] } })).rejects.toMatchObject({ code: "CLIENT_UPDATE_REQUIRED" });
  const changed = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 5, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }] } });
  const restored = await restoreVersion(env.DB, note.id, Number(version.id), { operation_id: uuidv7(), expected_revision: changed.note.revision });
  expect(restored.contentSchemaVersion).toBe(5);
  expect(restored.content).toEqual(rich);
});
