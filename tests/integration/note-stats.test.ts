import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createManualVersion, createNote, patchNote } from "../../worker/services/notes";
import { uploadAttachment } from "../../worker/services/attachments";
import { getNoteStats } from "../../worker/services/noteStats";
import { uuidv7 } from "../../src/api/client";
import { CURRENT_SCHEMA_VERSION } from "../../shared/schemaVersion";

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "a.png", { type: "image/png" });

it("summarises attachments by type and reference state plus version count, and hides other notes", async () => {
  const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: CURRENT_SCHEMA_VERSION });
  expect(await getNoteStats(env.DB, note.id)).toMatchObject({ attachments: { count: 0, size: 0 }, versions: { count: 0, latestAt: null } });

  const image = await uploadAttachment(env.DB, env.UPLOADS, note.id, uuidv7(), png());
  const pdf = await uploadAttachment(env.DB, env.UPLOADS, note.id, uuidv7(), new File(["%PDF-1.7\n"], "r.pdf", { type: "application/pdf" }));
  const doc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "stats" }] },
    { type: "image", attrs: { attachmentId: image.id, src: image.url, alt: "a.png" } },
    { type: "fileAttachment", attrs: { attachmentId: pdf.id, fileName: pdf.fileName, size: pdf.size, mime: pdf.mime } },
  ] };
  const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: CURRENT_SCHEMA_VERSION, content: doc });
  let stats = await getNoteStats(env.DB, note.id);
  expect(stats.attachments).toMatchObject({ count: 2, size: image.size + pdf.size, images: { count: 1, size: image.size }, files: { count: 1, size: pdf.size }, historyOnly: { count: 0 }, awaitingCleanup: { count: 0 } });

  await createManualVersion(env.DB, note.id, uuidv7());
  await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: CURRENT_SCHEMA_VERSION, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "stats" }] }] } });
  stats = await getNoteStats(env.DB, note.id);
  expect(stats.versions.count).toBe(1);
  expect(stats.versions.latestAt).toBeGreaterThan(0);
  expect(stats.attachments).toMatchObject({ count: 2, historyOnly: { count: 2, size: image.size + pdf.size }, awaitingCleanup: { count: 0 } });
});

it("rejects stats for missing notes", async () => {
  await expect(getNoteStats(env.DB, 999_999_999)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
});
