import { ApiError } from "../lib/http";
import { randomId, requestHash } from "../lib/crypto";
import { existingOperation, validateOperationId } from "./operations";
import type { AccountSession } from "./accountSessions";
import { businessWrite } from "./businessWrite";
import { getNote } from "./notes";

export async function queueHardDelete(db: D1Database, noteId: number, input: { operation_id: string; expected_revision: number }, session?: AccountSession) {
  validateOperationId(input.operation_id);
  const hash = await requestHash("DELETE", `/api/notes/${noteId}?hard=1`, input);
  const replay = await existingOperation(db, input.operation_id, hash, session?.user.id ?? null);
  if (replay?.status === "succeeded" && replay.result_id) return { operation_id: input.operation_id, job_id: replay.result_id, status: "queued" };
  if (replay) throw new ApiError(replay.status === "pending" ? 202 : 409, replay.result_code ?? "PURGE_FAILED", "清除操作未完成");
  await getNote(db, noteId, session);
  const jobId = randomId();
  const now = Date.now();
  await businessWrite(db, session, [
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at, user_id) VALUES (?, 'note.purge', ?, 'pending', ?, ?, ?)").bind(input.operation_id, hash, now, now + 604_800_000, session?.user.id ?? null),
    db.prepare("UPDATE uranus_notes SET purge_pending=1, revision=revision+1, last_operation_id=?, updated_at=? WHERE id=? AND revision=? AND deleted_at IS NOT NULL AND purge_pending=0 AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(input.operation_id, now, noteId, input.expected_revision),
    db.prepare("INSERT INTO uranus_maintenance_jobs(id, kind, status, attempt, next_attempt_at, created_at, updated_at, user_id) SELECT ?, ?, 'queued', 0, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=? AND purge_pending=1)").bind(jobId, `purge_note:${noteId}`, now, now, now, session?.user.id ?? null, noteId, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=?, result_revision=? WHERE operation_id=? AND EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id=?)").bind(jobId, input.expected_revision + 1, input.operation_id, jobId),
    db.prepare("UPDATE uranus_operations SET status='failed', result_code='REVISION_CONFLICT' WHERE operation_id=? AND status='pending'").bind(input.operation_id),
  ]);
  const operation = await existingOperation(db, input.operation_id, hash, session?.user.id ?? null);
  if (operation?.status !== "succeeded") throw new ApiError(409, "REVISION_CONFLICT", "笔记状态已改变");
  return { operation_id: input.operation_id, job_id: jobId, status: "queued" };
}

export async function queueEmptyTrash(db: D1Database, operationId: string, session?: AccountSession) {
  validateOperationId(operationId);
  const hash = await requestHash("POST", "/api/notes/empty-trash", { operation_id: operationId });
  const replay = await existingOperation(db, operationId, hash, session?.user.id ?? null);
  if (replay?.status === "succeeded" && replay.result_id) return { operation_id: operationId, job_id: replay.result_id, status: "queued" };
  if (replay) throw new ApiError(replay.status === "pending" ? 202 : 409, replay.result_code ?? "EMPTY_TRASH_FAILED", "清空操作未完成");
  const jobId = randomId();
  const now = Date.now();
  await businessWrite(db, session, [
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at, user_id) VALUES (?, 'trash.empty', ?, 'pending', ?, ?, ?)").bind(operationId, hash, now, now + 604_800_000, session?.user.id ?? null),
    db.prepare("INSERT INTO uranus_maintenance_jobs(id, kind, status, attempt, next_attempt_at, created_at, updated_at, user_id) SELECT ?, 'empty_trash', 'queued', 0, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(jobId, now, now, now, session?.user.id ?? null),
    db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=? WHERE operation_id=? AND EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id=?)").bind(jobId, operationId, jobId),
    db.prepare("UPDATE uranus_operations SET status='failed', result_code='MAINTENANCE_MODE' WHERE operation_id=? AND status='pending'").bind(operationId),
  ]);
  return { operation_id: operationId, job_id: jobId, status: "queued" };
}

export async function getJob(db: D1Database, id: string, session?: AccountSession) {
  const job = await db.prepare("SELECT id, kind, status, cursor, attempt, next_attempt_at, last_error_code, created_at, updated_at FROM uranus_maintenance_jobs WHERE id=? AND user_id IS ?").bind(id, session?.user.id ?? null).first();
  if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "维护任务不存在");
  return job;
}

async function acquireJob(db: D1Database, jobId: string, owner: string, now: number) {
  const result = await db.prepare("UPDATE uranus_maintenance_jobs SET status='running', lease_owner=?, lease_until=?, attempt=attempt+1, updated_at=? WHERE id=? AND status IN ('queued','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (lease_until IS NULL OR lease_until<?) AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(owner, now + 120_000, now, jobId, now, now).run();
  return (result.meta.changes ?? 0) === 1;
}

async function finishJob(db: D1Database, jobId: string, owner: string) {
  await db.prepare("UPDATE uranus_maintenance_jobs SET status='succeeded', lease_owner=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_owner=?").bind(Date.now(), jobId, owner).run();
}

async function retryJob(db: D1Database, jobId: string, owner: string, code: string) {
  const job = await db.prepare("SELECT attempt FROM uranus_maintenance_jobs WHERE id=? AND lease_owner=?").bind(jobId, owner).first<{ attempt: number }>();
  const attempt = job?.attempt ?? 8;
  const failed = attempt >= 8;
  const delay = Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));
  await db.prepare("UPDATE uranus_maintenance_jobs SET status=?, next_attempt_at=?, last_error_code=?, lease_owner=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_owner=?").bind(failed ? "failed" : "retry_wait", failed ? null : Date.now() + delay + Math.floor(Math.random() * 10_000), code, Date.now(), jobId, owner).run();
}

async function processPurgeNote(db: D1Database, bucket: R2Bucket, jobId: string, owner: string, noteId: number, userId: string | null) {
  if (!await db.prepare("SELECT id FROM uranus_notes WHERE id=? AND user_id IS ? AND purge_pending=1").bind(noteId, userId).first()) {
    await retryJob(db, jobId, owner, "PURGE_OWNER_MISMATCH");
    return;
  }
  const attachments = await db.prepare("SELECT id, object_key FROM uranus_attachments WHERE note_id=? LIMIT 20").bind(noteId).all<{ id: string; object_key: string }>();
  for (const attachment of attachments.results) {
    const claimed = await db.prepare("UPDATE uranus_attachments SET status='deleting', updated_at=? WHERE id=? AND note_id=? AND EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id=? AND user_id IS ? AND lease_owner=? AND lease_until>?) AND EXISTS(SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(Date.now(), attachment.id, noteId, jobId, userId, owner, Date.now()).run();
    if (claimed.meta.changes !== 1) return;
    if (!attachment.object_key.startsWith("uranus/attachments/")) { await retryJob(db, jobId, owner, "INVALID_ATTACHMENT_KEY"); return; }
    try {
      await bucket.delete(attachment.object_key);
      await db.prepare("DELETE FROM uranus_attachments WHERE id=? AND status='deleting'").bind(attachment.id).run();
    } catch {
      await db.prepare("UPDATE uranus_attachments SET last_error_code='R2_DELETE_FAILED', updated_at=? WHERE id=?").bind(Date.now(), attachment.id).run();
      await retryJob(db, jobId, owner, "R2_DELETE_FAILED");
      return;
    }
  }
  const remaining = await db.prepare("SELECT 1 FROM uranus_attachments WHERE note_id=? LIMIT 1").bind(noteId).first();
  if (remaining) {
    await db.prepare("UPDATE uranus_maintenance_jobs SET status='queued', lease_owner=NULL, lease_until=NULL, next_attempt_at=?, updated_at=? WHERE id=? AND lease_owner=?").bind(Date.now(), Date.now(), jobId, owner).run();
    return;
  }
  await db.batch([
    db.prepare("DELETE FROM uranus_notes WHERE id=? AND purge_pending=1 AND EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id=? AND lease_owner=?)").bind(noteId, jobId, owner),
    db.prepare("UPDATE uranus_maintenance_jobs SET status='succeeded', lease_owner=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_owner=?").bind(Date.now(), jobId, owner),
  ]);
}

async function processEmptyTrash(db: D1Database, jobId: string, owner: string, userId: string | null) {
  const notes = await db.prepare("SELECT id FROM uranus_notes WHERE user_id IS ? AND deleted_at IS NOT NULL AND purge_pending=0 ORDER BY id LIMIT 50").bind(userId).all<{ id: number }>();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const note of notes.results) {
    const childJob = randomId();
    statements.push(db.prepare("UPDATE uranus_notes SET purge_pending=1, revision=revision+1, updated_at=? WHERE id=? AND user_id IS ? AND deleted_at IS NOT NULL AND purge_pending=0 AND EXISTS(SELECT 1 FROM uranus_maintenance_jobs WHERE id=? AND lease_owner=? AND lease_until>?) AND EXISTS(SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(now, note.id, userId, jobId, owner, now));
    statements.push(db.prepare("INSERT INTO uranus_maintenance_jobs(id, kind, status, attempt, next_attempt_at, created_at, updated_at, user_id) SELECT ?, ?, 'queued', 0, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND user_id IS ? AND purge_pending=1)").bind(childJob, `purge_note:${note.id}`, now, now, now, userId, note.id, userId));
  }
  if (statements.length) await db.batch(statements);
  const remaining = await db.prepare("SELECT 1 FROM uranus_notes WHERE user_id IS ? AND deleted_at IS NOT NULL AND purge_pending=0 LIMIT 1").bind(userId).first();
  if (remaining) await db.prepare("UPDATE uranus_maintenance_jobs SET status='queued', lease_owner=NULL, lease_until=NULL, next_attempt_at=?, updated_at=? WHERE id=? AND lease_owner=?").bind(now, now, jobId, owner).run();
  else await finishJob(db, jobId, owner);
}

export async function discoverExpiredTrash(db: D1Database) {
  const notes = await db.prepare("SELECT id FROM uranus_notes WHERE deleted_at IS NOT NULL AND deleted_at<=? AND purge_pending=0 LIMIT 100").bind(Date.now() - 30 * 86_400_000).all<{ id: number }>();
  const now = Date.now();
  for (const note of notes.results) {
    const jobId = randomId();
    await db.batch([
      db.prepare("UPDATE uranus_notes SET purge_pending=1, revision=revision+1, updated_at=? WHERE id=? AND deleted_at IS NOT NULL AND purge_pending=0 AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(now, note.id),
      db.prepare("INSERT INTO uranus_maintenance_jobs(id, kind, status, attempt, next_attempt_at, created_at, updated_at, user_id) SELECT ?, ?, 'queued', 0, ?, ?, ?, user_id FROM uranus_notes WHERE id=? AND purge_pending=1").bind(jobId, `purge_note:${note.id}`, now, now, now, note.id),
    ]);
  }
}

export async function processMaintenance(db: D1Database, bucket: R2Bucket) {
  const now = Date.now();
  if (!(await db.prepare("SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal'").first())) return;
  // Recover interrupted attachment deletes, including records left by older clients.
  // A stable job id prevents repeated scans from resetting retry limits/backoff.
  await db.prepare(`INSERT OR IGNORE INTO uranus_maintenance_jobs(id, kind, status, attempt, next_attempt_at, created_at, updated_at, user_id)
    SELECT 'delete_attachment:' || a.id, 'delete_attachment:' || a.id, 'queued', 0, ?, ?, ?, n.user_id
    FROM uranus_attachments a JOIN uranus_notes n ON n.id=a.note_id
    WHERE a.status='deleting' AND a.updated_at<=? AND n.purge_pending=0
      AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs WHERE attachment_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id='delete_attachment:' || a.id)
    ORDER BY a.updated_at, a.id LIMIT 20`).bind(now, now, now, now - 120_000).run();
  await db.prepare(`UPDATE uranus_maintenance_jobs SET status=CASE WHEN attempt>=8 THEN 'failed' ELSE 'retry_wait' END,
    lease_owner=NULL, lease_until=NULL, next_attempt_at=CASE WHEN attempt>=8 THEN NULL ELSE ? END, last_error_code='LEASE_EXPIRED', updated_at=?
    WHERE kind LIKE 'delete_attachment:%' AND status='running' AND lease_until<=?`).bind(now, now, now).run();
  const jobs = await db.prepare("SELECT id, kind, user_id FROM uranus_maintenance_jobs WHERE status IN ('queued','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 5").bind(now).all<{ id: string; kind: string; user_id: string | null }>();
  for (const job of jobs.results) {
    const owner = randomId();
    if (!(await acquireJob(db, job.id, owner, Date.now()))) continue;
    try {
      if (job.kind === "empty_trash") await processEmptyTrash(db, job.id, owner, job.user_id);
      else if (job.kind.startsWith("delete_attachment:")) await processAttachmentDelete(db, bucket, job.id, owner, job.kind.slice(18), job.user_id);
      else if (job.kind.startsWith("purge_note:")) await processPurgeNote(db, bucket, job.id, owner, Number(job.kind.slice(11)), job.user_id);
      else await retryJob(db, job.id, owner, "UNKNOWN_JOB_KIND");
    } catch {
      await retryJob(db, job.id, owner, "JOB_EXECUTION_FAILED");
    }
  }
  const candidates = await db.prepare("SELECT id, object_key FROM uranus_attachments WHERE status='ready' AND unreferenced_at IS NOT NULL AND unreferenced_at<=? AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs WHERE attachment_id=uranus_attachments.id) LIMIT 20").bind(now - 86_400_000).all<{ id: string; object_key: string }>();
  for (const attachment of candidates.results) {
    const claimed = await db.prepare("UPDATE uranus_attachments SET status='deleting', updated_at=? WHERE id=? AND status='ready' AND unreferenced_at<=? AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs WHERE attachment_id=?)").bind(now, attachment.id, now - 86_400_000, attachment.id).run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    try { await bucket.delete(attachment.object_key); await db.prepare("DELETE FROM uranus_attachments WHERE id=? AND status='deleting'").bind(attachment.id).run(); }
    catch { await db.prepare("UPDATE uranus_attachments SET last_error_code='R2_DELETE_FAILED', updated_at=? WHERE id=?").bind(Date.now(), attachment.id).run(); }
  }
}

async function processAttachmentDelete(db: D1Database, bucket: R2Bucket, jobId: string, owner: string, id: string, userId: string | null) {
  const attachment = await db.prepare(`SELECT a.object_key FROM uranus_attachments a JOIN uranus_notes n ON n.id=a.note_id
    WHERE a.id=? AND n.user_id IS ? AND a.status='deleting' AND n.purge_pending=0
    AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs WHERE attachment_id=a.id)
    AND EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id=? AND lease_owner=? AND lease_until>?)
    AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')`).bind(id, userId, jobId, owner, Date.now()).first<{ object_key: string }>();
  if (!attachment) {
    if (!(await db.prepare("SELECT 1 FROM uranus_attachments WHERE id=?").bind(id).first())) await finishJob(db, jobId, owner);
    else await retryJob(db, jobId, owner, "ATTACHMENT_DELETE_BLOCKED");
    return;
  }
  if (!attachment.object_key.startsWith("uranus/attachments/")) {
    await retryJob(db, jobId, owner, "INVALID_ATTACHMENT_KEY");
    return;
  }
  try {
    // R2 delete is idempotent: also completes a prior R2 success / D1 failure.
    await bucket.delete(attachment.object_key);
    await db.prepare(`DELETE FROM uranus_attachments WHERE id=? AND status='deleting'
      AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs WHERE attachment_id=?)
      AND EXISTS (SELECT 1 FROM uranus_maintenance_jobs WHERE id=? AND lease_owner=? AND lease_until>?)`).bind(id, id, jobId, owner, Date.now()).run();
    if (!(await db.prepare("SELECT 1 FROM uranus_attachments WHERE id=?").bind(id).first())) await finishJob(db, jobId, owner);
    else await retryJob(db, jobId, owner, "ATTACHMENT_DELETE_BLOCKED");
  } catch {
    await db.prepare("UPDATE uranus_attachments SET last_error_code='R2_DELETE_FAILED', updated_at=? WHERE id=? AND status='deleting'").bind(Date.now(), id).run();
    await retryJob(db, jobId, owner, "R2_DELETE_FAILED");
  }
}
