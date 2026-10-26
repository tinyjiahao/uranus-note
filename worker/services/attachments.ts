import { ApiError } from "../lib/http";
import { randomId, requestHash, sha256 } from "../lib/crypto";
import { existingOperation, validateOperationId } from "./operations";
import type { AccountSession } from "./accountSessions";
import { businessWrite } from "./businessWrite";
import { getNote } from "./notes";

const MIME_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_FILE_BYTES = 10_000_000;

type AttachmentRow = {
  id: string; note_id: number; object_key: string; file_name: string; mime: string; size: number;
  etag: string | null; status: string; unreferenced_at: number | null;
};

function isMagicValid(mime: string, data: Uint8Array): boolean {
  if (mime === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, i) => data[i] === value);
  if (mime === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const ascii = (start: number, end: number) => String.fromCharCode(...data.slice(start, end));
  if (mime === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mime === "image/gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
  return false;
}

const safeFileName = (name: string) => name.replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 255) || "image";
const dto = (row: AttachmentRow) => ({ id: row.id, noteId: row.note_id, fileName: row.file_name, mime: row.mime, size: row.size, etag: row.etag, url: `/api/attachments/${row.id}` });

async function rowById(db: D1Database, id: string, session?: AccountSession): Promise<AttachmentRow> {
  const row = await db.prepare("SELECT a.id, a.note_id, a.object_key, a.file_name, a.mime, a.size, a.etag, a.status, a.unreferenced_at FROM uranus_attachments a JOIN uranus_notes n ON n.id=a.note_id WHERE a.id=? AND n.user_id IS ? AND n.purge_pending=0").bind(id, session?.user.id ?? null).first<AttachmentRow>();
  if (!row) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "附件不存在");
  return row;
}

export async function uploadAttachment(db: D1Database, bucket: R2Bucket, noteId: number, operationId: string, file: File, session?: AccountSession) {
  validateOperationId(operationId);
  if (!MIME_EXTENSIONS[file.type]) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 PNG、JPEG、WebP 和 GIF");
  if (file.size > MAX_FILE_BYTES) throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "附件超过 10,000,000 字节限制");
  const note = await db.prepare("SELECT id FROM uranus_notes WHERE id=? AND user_id IS ? AND deleted_at IS NULL AND purge_pending=0").bind(noteId, session?.user.id ?? null).first();
  if (!note) throw new ApiError(404, "NOTE_NOT_FOUND", "目标笔记不存在或不可编辑");
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size || buffer.byteLength > MAX_FILE_BYTES) throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "附件实际大小超过限制");
  if (!isMagicValid(file.type, new Uint8Array(buffer).slice(0, 16))) throw new ApiError(415, "INVALID_FILE_SIGNATURE", "文件内容与声明类型不符");
  const digest = await sha256(buffer);
  const hash = await requestHash("POST", "/api/attachments", { note_id: noteId, file_name: safeFileName(file.name), mime: file.type, size: file.size, digest });
  const replay = await existingOperation(db, operationId, hash, session?.user.id ?? null);
  if (replay?.status === "succeeded" && replay.result_id) return dto(await rowById(db, replay.result_id, session));
  if (replay) throw new ApiError(replay.status === "pending" ? 202 : 409, replay.result_code ?? "UPLOAD_PENDING", "上传操作未完成");
  const id = randomId();
  const lease = randomId();
  const objectKey = `uranus/attachments/${noteId}/${id}.${MIME_EXTENSIONS[file.type]}`;
  const now = Date.now();
  await businessWrite(db, session, [
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, lease_owner, lease_until, created_at, expires_at, user_id) VALUES (?, 'attachment.upload', ?, 'pending', ?, ?, ?, ?, ?)").bind(operationId, hash, lease, now + 120_000, now, now + 604_800_000, session?.user.id ?? null),
    db.prepare("INSERT INTO uranus_attachments(id, note_id, object_key, file_name, mime, size, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(id, noteId, objectKey, safeFileName(file.name), file.type, file.size, now, now),
  ]);
  try {
    const object = await bucket.put(objectKey, buffer, { httpMetadata: { contentType: file.type }, customMetadata: { sha256: digest } });
    await businessWrite(db, session, [
      db.prepare("UPDATE uranus_attachments SET status='ready', etag=?, unreferenced_at=?, updated_at=? WHERE id=? AND status='pending' AND EXISTS (SELECT 1 FROM uranus_operations WHERE operation_id=? AND lease_owner=? AND lease_until>?) AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND deleted_at IS NULL AND purge_pending=0) AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(object.etag, now, now, id, operationId, lease, Date.now(), noteId),
      db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=? WHERE operation_id=? AND lease_owner=? AND EXISTS (SELECT 1 FROM uranus_attachments WHERE id=? AND status='ready')").bind(id, operationId, lease, id),
      db.prepare("UPDATE uranus_operations SET status='failed', result_code='UPLOAD_COMMIT_REJECTED' WHERE operation_id=? AND status='pending'").bind(operationId),
    ]);
  } catch (error) {
    // Compensate only the object created by this attempt. Cleanup is a platform
    // obligation after revocation, not a new user-authorized business write.
    await db.batch([
      db.prepare("UPDATE uranus_attachments SET status='deleting', last_error_code='UPLOAD_ABORTED', updated_at=? WHERE id=? AND status='pending'").bind(Date.now(), id),
      db.prepare("UPDATE uranus_operations SET status='failed', result_code='UPLOAD_ABORTED' WHERE operation_id=? AND status='pending' AND lease_owner=?").bind(operationId, lease),
    ]);
    try {
      await bucket.delete(objectKey);
      await db.prepare("DELETE FROM uranus_attachments WHERE id=? AND status='deleting'").bind(id).run();
    } catch { /* Durable deleting row is picked up by existing cleanup discovery. */ }
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "R2_WRITE_FAILED", "附件存储暂不可用");
  }
  const operation = await existingOperation(db, operationId, hash, session?.user.id ?? null);
  if (operation?.status !== "succeeded") {
    await bucket.delete(objectKey).catch(() => undefined);
    throw new ApiError(503, operation?.result_code ?? "UPLOAD_COMMIT_REJECTED", "上传完成确认失败，请重试");
  }
  return dto(await rowById(db, id, session));
}

export async function downloadAttachment(db: D1Database, bucket: R2Bucket, id: string, ifNoneMatch?: string, session?: AccountSession) {
  const row = await rowById(db, id, session);
  if (row.status !== "ready") throw new ApiError(404, "ATTACHMENT_NOT_READY", "附件不可用");
  if (ifNoneMatch && row.etag && ifNoneMatch.replaceAll('"', "") === row.etag.replaceAll('"', "")) return { row, object: null, notModified: true };
  const object = await bucket.get(row.object_key);
  if (!object) throw new ApiError(503, "ATTACHMENT_OBJECT_MISSING", "附件对象暂不可用");
  return { row, object, notModified: false };
}

export async function deleteAttachment(db: D1Database, bucket: R2Bucket, id: string, session?: AccountSession) {
  const row = await rowById(db, id, session);
  const [result] = await businessWrite(db, session, [db.prepare("UPDATE uranus_attachments SET status='deleting', updated_at=? WHERE id=? AND status IN ('ready','error') AND EXISTS(SELECT 1 FROM uranus_notes WHERE id=note_id AND user_id IS ?) AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs WHERE attachment_id=?)").bind(Date.now(), id, session?.user.id ?? null, id)]);
  if ((result?.meta.changes ?? 0) === 0) throw new ApiError(409, "ATTACHMENT_REFERENCED", "附件仍被正文或历史版本引用");
  try {
    await bucket.delete(row.object_key);
    await db.prepare("DELETE FROM uranus_attachments WHERE id=? AND status='deleting'").bind(id).run();
    return { deleted: true };
  } catch {
    await db.prepare("UPDATE uranus_attachments SET last_error_code='R2_DELETE_FAILED', updated_at=? WHERE id=? AND status='deleting'").bind(Date.now(), id).run();
    throw new ApiError(503, "R2_DELETE_FAILED", "附件删除已排队重试");
  }
}

export async function copyAttachment(db: D1Database, bucket: R2Bucket, sourceId: string, targetNoteId: number, operationId: string, session?: AccountSession) {
  validateOperationId(operationId);
  const source = await rowById(db, sourceId, session);
  await getNote(db, targetNoteId, session);
  if (source.status !== "ready") throw new ApiError(404, "ATTACHMENT_NOT_READY", "源附件不可用");
  const object = await bucket.get(source.object_key);
  if (!object) throw new ApiError(503, "ATTACHMENT_OBJECT_MISSING", "源附件对象缺失");
  const file = new File([await object.arrayBuffer()], source.file_name, { type: source.mime });
  return uploadAttachment(db, bucket, targetNoteId, operationId, file, session);
}
