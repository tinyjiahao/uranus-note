import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createNote, createManualVersion, getVersion, patchNote, restoreVersion } from "../../worker/services/notes";
import { uploadAttachment, deleteAttachment } from "../../worker/services/attachments";
import { validateAndDeriveContent } from "../../shared/content";
import { uuidv7 } from "../../src/api/client";

const image = (id: string, align: unknown = null) => ({ type: "image", attrs: { attachmentId: id, src: `/api/attachments/${id}`, imageAlign: align } });
const table = (picture: ReturnType<typeof image>) => ({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph" }, picture] }, { type: "tableCell", content: [picture, { type: "paragraph", content: [{ type: "text", text: "图片说明" }] }] }] }] }] });
it("saves table images and alignment, preserves historical references and rejects old clients", async () => {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 3 });
  const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0,0,0,0]);
  const attachment = await uploadAttachment(env.DB, env.UPLOADS, note.id, uuidv7(), new File([png], "image.png", { type: "image/png" }));
  const content = table(image(attachment.id, "right"));
  const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: 4, content });
  expect(saved.note.content).toEqual(content); expect(saved.note.contentSchemaVersion).toBe(4);
  const version = await createManualVersion(env.DB, note.id, uuidv7());
  expect((await getVersion(env.DB, note.id, Number(version.id))).content).toEqual(content);
  await expect(patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 3, content: { type: "doc", content: [{ type: "paragraph" }] } })).rejects.toMatchObject({ code: "CLIENT_UPDATE_REQUIRED" });
  const removed = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 4, content: { type: "doc", content: [{ type: "paragraph" }] } });
  await expect(deleteAttachment(env.DB, env.UPLOADS, attachment.id)).rejects.toMatchObject({ code: "ATTACHMENT_REFERENCED" });
  const restored = await restoreVersion(env.DB, note.id, Number(version.id), { operation_id: uuidv7(), expected_revision: removed.note.revision });
  expect(restored.content).toEqual(content); expect(restored.contentSchemaVersion).toBe(4);
  expect(await env.UPLOADS.head(`uranus/attachments/${note.id}/${attachment.id}.png`)).not.toBeNull();
});
it("validates image alignment, table capabilities, nested blocks and attachment URLs", () => {
  for (const align of [null, "left", "center", "right"]) expect(validateAndDeriveContent(table(image("a", align))).attachmentIds).toEqual(["a"]);
  for (const align of ["justify", "right;color:red", {}, 1]) expect(() => validateAndDeriveContent(table(image("a", align)))).toThrow();
  expect(() => validateAndDeriveContent(table(image("a")), 3)).toThrow(/新版客户端/);
  expect(() => validateAndDeriveContent({ type: "doc", content: [image("a", "left")] }, 3)).toThrow(/新版客户端/);
  expect(() => validateAndDeriveContent(table({ type: "image", attrs: { attachmentId: "a", src: "https://example.com/a.png", imageAlign: null } }))).toThrow(/当前实例附件/);
  const invalid = table(image("a")); invalid.content[0]!.content[0]!.content[0]!.content = [{ type: "table" } as never];
  expect(() => validateAndDeriveContent(invalid)).toThrow(/单元格/);
});
