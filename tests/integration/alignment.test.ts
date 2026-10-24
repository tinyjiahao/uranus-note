import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createNote, createManualVersion, getVersion, patchNote, restoreVersion } from "../../worker/services/notes";
import { validateAndDeriveContent } from "../../shared/content";
import { uuidv7 } from "../../src/api/client";

const content = (alignment: unknown) => ({ type: "doc", content: [{ type: "heading", attrs: { level: 1, textAlign: alignment }, content: [{ type: "text", text: "标题" }] }, { type: "paragraph", attrs: { textAlign: alignment }, content: [{ type: "text", text: "正文" }] }] });
it("preserves block alignment across saving and history and blocks old clients", async () => {
  const old = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 2 });
  const saved = await patchNote(env.DB, old.id, { operation_id: uuidv7(), expected_revision: old.revision, content_schema_version: 3, content: content("center") });
  expect(saved.note.contentSchemaVersion).toBe(3);
  expect(saved.note.content).toEqual(content("center"));
  const version = await createManualVersion(env.DB, old.id, uuidv7());
  expect((await getVersion(env.DB, old.id, Number(version.id))).content).toEqual(content("center"));
  await expect(patchNote(env.DB, old.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 2, content: { type: "doc", content: [{ type: "paragraph" }] } })).rejects.toMatchObject({ code: "CLIENT_UPDATE_REQUIRED" });
  const next = await patchNote(env.DB, old.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 3, content: content("right") });
  const restored = await restoreVersion(env.DB, old.id, Number(version.id), { operation_id: uuidv7(), expected_revision: next.note.revision });
  expect(restored.contentSchemaVersion).toBe(3); expect(restored.content).toEqual(content("center"));
});
it("validates alignment enums and schema capabilities", async () => {
  for (const value of ["left", "center", "right", null]) expect(() => validateAndDeriveContent(content(value))).not.toThrow();
  for (const value of ["justify", "center;color:red", {}, 1]) expect(() => validateAndDeriveContent(content(value))).toThrow();
  await expect(createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 2, content: content("center") })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_SCHEMA" });
});
