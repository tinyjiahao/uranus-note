import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { deleteAttachment } from "../../worker/services/attachments";
import { processMaintenance } from "../../worker/services/maintenance";

async function fixture(status = "ready") {
  const id = crypto.randomUUID();
  const note = await env.DB.prepare("INSERT INTO uranus_notes(folder_id,content_json,content_schema_version,last_operation_id,created_at,updated_at) SELECT id,?,1,?,?,? FROM uranus_folders WHERE system_key='default' RETURNING id").bind('{"type":"doc","content":[{"type":"paragraph"}]}', crypto.randomUUID(), Date.now(), Date.now()).first<{ id: number }>();
  const key = `uranus/attachments/${note!.id}/${id}.png`;
  await env.DB.prepare("INSERT INTO uranus_attachments(id,note_id,object_key,file_name,mime,size,status,unreferenced_at,created_at,updated_at) VALUES (?,?,?,'test.png','image/png',1,?,?,?,?)").bind(id, note!.id, key, status, Date.now() - 90_000_000, Date.now() - 90_000_000, Date.now() - 180_000).run();
  await env.UPLOADS.put(key, "x");
  return { id, key, noteId: note!.id };
}
const row = (id: string) => env.DB.prepare("SELECT * FROM uranus_attachments WHERE id=?").bind(id).first();
const job = (id: string) => env.DB.prepare("SELECT * FROM uranus_maintenance_jobs WHERE id=?").bind(`delete_attachment:${id}`).first<{ status: string; attempt: number; next_attempt_at: number }>();
const age = (id: string) => env.DB.prepare("UPDATE uranus_attachments SET updated_at=? WHERE id=?").bind(Date.now() - 180_000, id).run();
const failingBucket = () => ({ delete: vi.fn().mockRejectedValue(new Error("unavailable")) }) as unknown as R2Bucket;

it("retries a failed explicit delete with backoff then removes R2 before metadata", async () => {
  const a = await fixture();
  await expect(deleteAttachment(env.DB, failingBucket(), a.id)).rejects.toMatchObject({ code: "R2_DELETE_FAILED" });
  await age(a.id);
  await processMaintenance(env.DB, failingBucket());
  expect(await row(a.id)).toMatchObject({ status: "deleting", object_key: a.key });
  expect(await job(a.id)).toMatchObject({ status: "retry_wait", attempt: 1 });
  expect((await job(a.id))!.next_attempt_at).toBeGreaterThan(Date.now());
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await env.UPLOADS.head(a.key)).not.toBeNull();
  await env.DB.prepare("UPDATE uranus_maintenance_jobs SET next_attempt_at=0 WHERE id=?").bind(`delete_attachment:${a.id}`).run();
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await env.UPLOADS.head(a.key)).toBeNull();
  expect(await row(a.id)).toBeNull();
  expect(await job(a.id)).toMatchObject({ status: "succeeded" });
});

it("recovers failed garbage collection and missing R2 objects", async () => {
  const a = await fixture();
  await processMaintenance(env.DB, failingBucket());
  expect(await row(a.id)).toMatchObject({ status: "deleting" });
  await age(a.id);
  await env.UPLOADS.delete(a.key);
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await row(a.id)).toBeNull();
  expect(await job(a.id)).toMatchObject({ status: "succeeded" });
});

it("recovers expired leases and stops at the retry limit without recreating jobs", async () => {
  const a = await fixture("deleting");
  await processMaintenance(env.DB, failingBucket());
  await env.DB.prepare("UPDATE uranus_maintenance_jobs SET status='running', lease_owner='interrupted', lease_until=0, attempt=7 WHERE id=?").bind(`delete_attachment:${a.id}`).run();
  await processMaintenance(env.DB, failingBucket());
  expect(await job(a.id)).toMatchObject({ status: "failed", attempt: 8 });
  await age(a.id);
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await job(a.id)).toMatchObject({ status: "failed", attempt: 8 });
  expect(await env.UPLOADS.head(a.key)).not.toBeNull();
  await env.DB.prepare("UPDATE uranus_maintenance_jobs SET status='queued', attempt=0, next_attempt_at=0 WHERE id=? AND status='failed'").bind(`delete_attachment:${a.id}`).run();
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await row(a.id)).toBeNull();
  expect(await job(a.id)).toMatchObject({ status: "succeeded" });
});

it("preserves referenced attachments and foreign objects, and pauses in maintenance mode", async () => {
  const a = await fixture("deleting");
  await env.DB.prepare("INSERT INTO uranus_attachment_refs(attachment_id,note_id) VALUES (?,?)").bind(a.id, a.noteId).run();
  await env.UPLOADS.put("other-app/cleanup-sentinel", "keep");
  const b = await fixture("deleting");
  await env.DB.prepare("UPDATE uranus_attachments SET object_key='other-app/cleanup-sentinel' WHERE id=?").bind(b.id).run();
  const c = await fixture("deleting");
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='draining' WHERE id=1").run();
  try {
    await processMaintenance(env.DB, env.UPLOADS);
    expect(await job(c.id)).toBeNull();
  } finally { await env.DB.prepare("UPDATE uranus_runtime_state SET mode='normal' WHERE id=1").run(); }
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await env.UPLOADS.head(a.key)).not.toBeNull();
  expect(await job(a.id)).toBeNull();
  expect(await env.UPLOADS.head("other-app/cleanup-sentinel")).not.toBeNull();
  expect(await row(b.id)).not.toBeNull();
  expect(await row(c.id)).toBeNull();
});

it("concurrent maintenance executions lease an attachment job only once", async () => {
  const a = await fixture("deleting");
  const remove = vi.fn(async (key: string) => { await env.UPLOADS.delete(key); });
  const bucket = { delete: remove } as unknown as R2Bucket;
  await Promise.all([processMaintenance(env.DB, bucket), processMaintenance(env.DB, bucket)]);
  expect(remove.mock.calls.filter(([key]) => key === a.key)).toHaveLength(1);
  expect(await row(a.id)).toBeNull();
  expect(await job(a.id)).toMatchObject({ status: "succeeded" });
});

it("rechecks references before retrying an already queued attachment", async () => {
  const a = await fixture("deleting");
  await processMaintenance(env.DB, failingBucket());
  // Simulate an inconsistent old record; retry must not delete its object.
  await env.DB.prepare("INSERT INTO uranus_attachment_refs(attachment_id,note_id) VALUES (?,?)").bind(a.id, a.noteId).run();
  await env.DB.prepare("UPDATE uranus_maintenance_jobs SET next_attempt_at=0 WHERE id=?").bind(`delete_attachment:${a.id}`).run();
  await processMaintenance(env.DB, env.UPLOADS);
  expect(await env.UPLOADS.head(a.key)).not.toBeNull();
  expect(await row(a.id)).not.toBeNull();
  expect(await job(a.id)).toMatchObject({ status: "retry_wait" });
});
