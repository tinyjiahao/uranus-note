import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { uploadAttachment, deleteAttachment } from "../../worker/services/attachments";
import { createManualVersion, createNote, getNote, listNotes, patchNote } from "../../worker/services/notes";

function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(now);
  for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const paragraph = (value: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });

describe("D1 note consistency", () => {
  beforeAll(async () => {
    await env.DB.prepare("CREATE TABLE sentinel_other_app(id INTEGER PRIMARY KEY, value TEXT)").run();
    await env.DB.prepare("INSERT INTO sentinel_other_app(id,value) VALUES (1,'keep')").run();
    await env.UPLOADS.put("other-app/keep.bin", new Uint8Array([1, 2, 3]));
  });

  it("creates, saves and searches Unicode literal substrings", async () => {
    const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 1 });
    const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: note.revision, content_schema_version: 1, content: paragraph("中文 %_ Literal") });
    expect(saved.applied_revision).toBe(2);
    expect((await listNotes(env.DB, { q: "%_" })).items.map((item) => item.id)).toContain(note.id);
    expect((await listNotes(env.DB, { q: "中文" })).items.map((item) => item.id)).toContain(note.id);
  });

  it("allows only one writer for the same revision and keeps derived search consistent", async () => {
    const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 1 });
    const results = await Promise.allSettled([
      patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: 1, content: paragraph("winner-one") }),
      patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: 1, content: paragraph("winner-two") }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await getNote(env.DB, note.id);
    const first = (await listNotes(env.DB, { q: "winner-one" })).items.some((item) => item.id === note.id);
    const second = (await listNotes(env.DB, { q: "winner-two" })).items.some((item) => item.id === note.id);
    expect(Number(first) + Number(second)).toBe(1);
    expect(current.revision).toBe(2);
  });

  it("keeps an attachment while a historical version references it", async () => {
    const note = await createNote(env.DB, { operation_id: uuidv7(), content_schema_version: 1 });
    const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0,0,0,0]);
    const attachment = await uploadAttachment(env.DB, env.UPLOADS, note.id, uuidv7(), new File([png], "tiny.png", { type: "image/png" }));
    const withImage = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "picture" }] }, { type: "image", attrs: { attachmentId: attachment.id, src: attachment.url } }] };
    const saved = await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: 1, content: withImage });
    await createManualVersion(env.DB, note.id, uuidv7());
    await patchNote(env.DB, note.id, { operation_id: uuidv7(), expected_revision: saved.note.revision, content_schema_version: 2, content: paragraph("removed") });
    await expect(deleteAttachment(env.DB, env.UPLOADS, attachment.id)).rejects.toMatchObject({ code: "ATTACHMENT_REFERENCED" });
  });

  it("does not touch other applications' D1 tables or R2 prefixes", async () => {
    expect((await env.DB.prepare("SELECT value FROM sentinel_other_app WHERE id=1").first<{ value: string }>())?.value).toBe("keep");
    expect(await env.UPLOADS.head("other-app/keep.bin")).not.toBeNull();
  });
});
