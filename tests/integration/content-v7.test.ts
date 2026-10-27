import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createManualVersion, createNote, getVersion, patchNote, restoreVersion, listNotes } from "../../worker/services/notes";
import { copyAttachment, deleteAttachment, uploadAttachment } from "../../worker/services/attachments";
import { processMaintenance } from "../../worker/services/maintenance";
import { uuidv7 } from "../../src/api/client";
import { CURRENT_SCHEMA_VERSION } from "../../shared/schemaVersion";

it("persists both colors, restores history and rejects old-client overwrites", async () => {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 11 });
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "colors", marks: [{ type: "textColor", attrs: { color: "#1858bc" } }, { type: "highlight", attrs: { color: "#baf3db" } }] }] }] };
  const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: 11, content });
  expect(saved.note.content).toEqual(content);
  const version = await createManualVersion(env.DB, note.id, uuidv7());
  expect((await getVersion(env.DB, note.id, Number(version.id))).content).toEqual(content);
  await expect(patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 10, content })).rejects.toMatchObject({ code: "CLIENT_UPDATE_REQUIRED" });
  const blank = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 11, content: { type: "doc", content: [{ type: "paragraph" }] } });
  expect((await restoreVersion(env.DB, note.id, Number(version.id), { operation_id: uuidv7(), expected_revision: blank.note.revision })).content).toEqual(content);
});

it("persists table file references, history and target-owned copies with schema 10", async () => {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 10 });
  const file = await uploadAttachment(env.DB, env.UPLOADS, note.id, uuidv7(), new File(["%PDF-1.7\n"], "cell.pdf", { type: "application/pdf" }));
  const document = (id: string) => ({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "fileAttachment", attrs: { attachmentId: id, fileName: file.fileName, mime: file.mime, size: file.size, display: "card" } }] }] }] }] });
  const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: 10, content: document(file.id) });
  expect(saved.note.content).toEqual(document(file.id));
  const version = await createManualVersion(env.DB, note.id, uuidv7());
  const blank = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 10, content: { type: "doc", content: [{ type: "paragraph" }] } });
  await expect(deleteAttachment(env.DB, env.UPLOADS, file.id)).rejects.toMatchObject({ code: "ATTACHMENT_REFERENCED" });
  expect((await restoreVersion(env.DB, note.id, Number(version.id), { operation_id: uuidv7(), expected_revision: blank.note.revision })).content).toEqual(document(file.id));
  const target = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 10 });
  const copy = await copyAttachment(env.DB, env.UPLOADS, file.id, target.id, uuidv7());
  expect(copy.id).not.toBe(file.id);
  expect((await patchNote(env.DB, target.id, { operation_id: uuidv7(), expected_revision: target.revision, content_schema_version: 10, content: document(copy.id) })).note.content).toEqual(document(copy.id));
});

it("saves and restores labels, files and links, guards metadata and historical references, copies and collects files", async () => {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: CURRENT_SCHEMA_VERSION });
  const attachment = await uploadAttachment(env.DB, env.UPLOADS, note.id, uuidv7(), new File(["%PDF-1.7\n"], "report.pdf", { type: "application/pdf" }));
  const content = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "label", attrs: { text: "unique-label-v7", color: "pink" } }, { type: "noteLink", attrs: { noteId: 987654, title: "linked snapshot" } }] },
    { type: "fileAttachment", attrs: { attachmentId: attachment.id, fileName: attachment.fileName, size: attachment.size, mime: attachment.mime, display: "card" } },
  ] };
  const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: CURRENT_SCHEMA_VERSION, content });
  expect(saved.note.content).toEqual(content);
  expect((await listNotes(env.DB, { q: "unique-label-v7" })).items.some(item => item.id === note.id)).toBe(true);
  const version = await createManualVersion(env.DB, note.id, uuidv7());
  expect((await getVersion(env.DB, note.id, Number(version.id))).content).toEqual(content);
  await expect(patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 5, content })).rejects.toMatchObject({ code: "CLIENT_UPDATE_REQUIRED" });
  const forged = structuredClone(content); forged.content[1]!.attrs!.size = 123;
  await expect(patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: CURRENT_SCHEMA_VERSION, content: forged })).rejects.toMatchObject({ code: "INVALID_ATTACHMENT" });
  const blank = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: CURRENT_SCHEMA_VERSION, content: { type: "doc", content: [{ type: "paragraph" }] } });
  await expect(deleteAttachment(env.DB, env.UPLOADS, attachment.id)).rejects.toMatchObject({ code: "ATTACHMENT_REFERENCED" });
  expect((await restoreVersion(env.DB, note.id, Number(version.id), { operation_id: uuidv7(), expected_revision: blank.note.revision })).content).toEqual(content);
  const target = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: CURRENT_SCHEMA_VERSION });
  const copied = await copyAttachment(env.DB, env.UPLOADS, attachment.id, target.id, uuidv7());
  expect(copied.id).not.toBe(attachment.id); expect(copied.mime).toBe("application/pdf");
  await env.DB.prepare("UPDATE uranus_attachments SET unreferenced_at=?,updated_at=? WHERE id=?").bind(Date.now() - 90_000_000, Date.now() - 180_000, copied.id).run();
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await env.UPLOADS.head(`uranus/attachments/${target.id}/${copied.id}.pdf`)).toBeNull();
  expect(await env.UPLOADS.head(`uranus/attachments/${note.id}/${attachment.id}.pdf`)).not.toBeNull();
});
