import { Hono } from "hono";
import { version as appVersion } from "../../package.json";
import { z } from "zod";
import { ApiError } from "../lib/http";
import { getJob } from "../services/maintenance";
import type { Env, AppVariables } from "../types";
import { validateOperationId } from "../services/operations";
import { sha256 } from "../lib/crypto";
import { validateAndDeriveContent } from "../../shared/content";

export const maintenanceRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
maintenanceRoutes.get("/mode", async (c) => {
  const state = await c.env.DB.prepare("SELECT mode, generation, maintenance_id, started_at FROM uranus_runtime_state WHERE id=1").first();
  return c.json(state);
});
maintenanceRoutes.post("/mode", async (c) => {
  const parsed = z.object({ operation_id: z.string().uuid(), purpose: z.enum(["backup", "restore"]).default("backup") }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "维护模式请求无效");
  validateOperationId(parsed.data.operation_id);
  const now = Date.now();
  const before = await c.env.DB.prepare("SELECT mode, generation, maintenance_id, started_at FROM uranus_runtime_state WHERE id=1").first<{ mode: string; generation: number; maintenance_id: string | null; started_at: number | null }>();
  if (before?.mode !== "normal") {
    if (before?.maintenance_id !== parsed.data.operation_id) throw new ApiError(409, "MAINTENANCE_ALREADY_ACTIVE", "另一维护任务已在进行");
    if (parsed.data.purpose === "restore" && before.mode === "restoring") return c.json(before);
    if (parsed.data.purpose === "restore" && before.mode === "frozen") return c.json(before);
  }
  if (parsed.data.purpose === "restore") {
    const occupied = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM uranus_notes) + (SELECT COUNT(*) FROM uranus_attachments) + (SELECT COUNT(*) FROM uranus_note_versions) + (SELECT COUNT(*) FROM uranus_folders WHERE system_key IS NULL) AS count").first<{ count: number }>();
    if ((occupied?.count ?? 1) !== 0) throw new ApiError(409, "RESTORE_TARGET_NOT_EMPTY", "恢复只允许空的 Uranus 目标空间");
    await c.env.DB.prepare("UPDATE uranus_runtime_state SET mode='restoring', generation=generation+1, maintenance_id=?, started_at=? WHERE id=1 AND mode='normal'").bind(parsed.data.operation_id, now).run();
  } else {
    await c.env.DB.prepare("UPDATE uranus_runtime_state SET mode='draining', generation=generation+1, maintenance_id=?, started_at=? WHERE id=1 AND mode='normal'").bind(parsed.data.operation_id, now).run();
  }
  const state = await c.env.DB.prepare("SELECT mode, generation, maintenance_id, started_at FROM uranus_runtime_state WHERE id=1").first<{ mode: string; generation: number; maintenance_id: string | null; started_at: number | null }>();
  if (state?.maintenance_id !== parsed.data.operation_id) throw new ApiError(409, "MAINTENANCE_ALREADY_ACTIVE", "另一维护任务已在进行");
  if (state.mode === "restoring") return c.json(state);
  if (state.mode === "draining") {
    const active = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM uranus_operations WHERE status='pending' AND lease_until>?) + (SELECT COUNT(*) FROM uranus_maintenance_jobs WHERE status='running' AND lease_until>?) + (SELECT COUNT(*) FROM uranus_attachments WHERE status IN ('pending','deleting')) AS count").bind(now, now).first<{ count: number }>();
    if ((active?.count ?? 1) === 0) await c.env.DB.prepare("UPDATE uranus_runtime_state SET mode='frozen' WHERE id=1 AND mode='draining' AND maintenance_id=?").bind(parsed.data.operation_id).run();
  }
  const current = await c.env.DB.prepare("SELECT mode, generation, maintenance_id, started_at FROM uranus_runtime_state WHERE id=1").first();
  return c.json(current, (current as { mode?: string })?.mode === "frozen" ? 200 : 202);
});
maintenanceRoutes.delete("/mode", async (c) => {
  const parsed = z.object({ maintenance_id: z.string().uuid(), confirm: z.literal(true) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "退出维护模式需要明确确认");
  const result = await c.env.DB.prepare("UPDATE uranus_runtime_state SET mode='normal', maintenance_id=NULL, started_at=NULL WHERE id=1 AND maintenance_id=? AND mode IN ('draining','frozen')").bind(parsed.data.maintenance_id).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "MAINTENANCE_ID_MISMATCH", "维护任务标识不匹配");
  return c.json({ mode: "normal" });
});

maintenanceRoutes.get("/backup", async (c) => {
  const maintenanceId = c.req.query("maintenance_id");
  const entity = c.req.query("entity") ?? "metadata";
  const state = await c.env.DB.prepare("SELECT mode, generation, maintenance_id FROM uranus_runtime_state WHERE id=1").first<{ mode: string; generation: number; maintenance_id: string | null }>();
  if (state?.mode !== "frozen" || !maintenanceId || state.maintenance_id !== maintenanceId) throw new ApiError(409, "BACKUP_NOT_FROZEN", "备份仅能在匹配的冻结维护模式下执行");
  if (entity === "metadata") {
    const counts: Record<string, number> = {};
    for (const [name, table] of Object.entries({ folders: "uranus_folders", notes: "uranus_notes", versions: "uranus_note_versions", attachments: "uranus_attachments", refs: "uranus_attachment_refs" })) {
      counts[name] = (await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())?.count ?? 0;
    }
    return c.json({ backupFormatVersion: 1, appVersion, migrationVersion: "0003_content_v2", contentSchemaVersion: 2, maintenanceId, generation: state.generation, counts });
  }
  const tables: Record<string, string> = { folders: "uranus_folders", notes: "uranus_notes", versions: "uranus_note_versions", attachments: "uranus_attachments", refs: "uranus_attachment_refs" };
  const table = tables[entity];
  if (!table) throw new ApiError(400, "INVALID_BACKUP_ENTITY", "不支持的备份实体");
  const cursor = Math.max(0, Number(c.req.query("cursor") ?? 0));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 100)));
  const result = await c.env.DB.prepare(`SELECT rowid AS backup_rowid, * FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).bind(cursor, limit + 1).all<Record<string, unknown>>();
  const items = result.results.slice(0, limit);
  const nextCursor = result.results.length > limit ? Number(items.at(-1)?.backup_rowid) : null;
  return c.json({ entity, items, nextCursor });
});

const restoreBatchSchema = z.object({
  maintenance_id: z.string().uuid(), backup_id: z.string().min(1).max(128), batch_id: z.string().min(1).max(128),
  entity: z.enum(["folders", "notes", "versions", "attachments", "refs", "search", "finalize"]),
  checksum: z.string().min(32).max(128), items: z.array(z.record(z.string(), z.unknown())).max(100),
});

maintenanceRoutes.post("/restore", async (c) => {
  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.startsWith("application/octet-stream")) {
    const maintenanceId = c.req.header("X-Maintenance-Id") ?? "";
    const backupId = c.req.header("X-Backup-Id") ?? "";
    const batchId = c.req.header("X-Batch-Id") ?? "";
    const expectedChecksum = c.req.header("X-Content-SHA256") ?? "";
    const attachmentId = c.req.query("attachment_id") ?? "";
    const state = await c.env.DB.prepare("SELECT mode, maintenance_id FROM uranus_runtime_state WHERE id=1").first<{ mode: string; maintenance_id: string | null }>();
    if (state?.mode !== "restoring" || state.maintenance_id !== maintenanceId) throw new ApiError(409, "RESTORE_MODE_MISMATCH", "恢复维护状态不匹配");
    const existing = await c.env.DB.prepare("SELECT checksum FROM uranus_restore_batches WHERE backup_id=? AND batch_id=?").bind(backupId, batchId).first<{ checksum: string }>();
    if (existing) {
      if (existing.checksum !== expectedChecksum) throw new ApiError(409, "RESTORE_BATCH_MISMATCH", "恢复批次 id 已用于不同内容");
      return c.json({ restored: true, replayed: true });
    }
    const row = await c.env.DB.prepare("SELECT id, object_key, mime, size, status FROM uranus_attachments WHERE id=?").bind(attachmentId).first<{ id: string; object_key: string; mime: string; size: number; status: string }>();
    if (!row || row.status !== "pending" || !row.object_key.startsWith("uranus/attachments/")) throw new ApiError(409, "RESTORE_ATTACHMENT_NOT_READY", "附件元数据尚未导入或状态无效");
    const declared = Number(c.req.header("Content-Length") ?? 0);
    if (declared !== row.size || declared > 10_000_000) throw new ApiError(413, "RESTORE_SIZE_MISMATCH", "附件长度与清单不一致");
    const body = await c.req.arrayBuffer();
    if (body.byteLength !== row.size || await sha256(body) !== expectedChecksum) throw new ApiError(409, "RESTORE_CHECKSUM_MISMATCH", "附件校验和不一致");
    const object = await c.env.UPLOADS.put(row.object_key, body, { httpMetadata: { contentType: row.mime }, customMetadata: { sha256: expectedChecksum } });
    try {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE uranus_attachments SET status='ready', etag=?, updated_at=? WHERE id=? AND status='pending'").bind(object.etag, Date.now(), attachmentId),
        c.env.DB.prepare("INSERT INTO uranus_restore_batches(backup_id,batch_id,checksum,entity,created_at) VALUES (?,?,?,'attachment_bytes',?)").bind(backupId, batchId, expectedChecksum, Date.now()),
      ]);
    } catch (error) {
      await c.env.UPLOADS.delete(row.object_key).catch(() => undefined);
      throw error;
    }
    return c.json({ restored: true, attachment_id: attachmentId });
  }

  const parsed = restoreBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "恢复批次格式无效");
  const input = parsed.data;
  const state = await c.env.DB.prepare("SELECT mode, maintenance_id FROM uranus_runtime_state WHERE id=1").first<{ mode: string; maintenance_id: string | null }>();
  if (state?.mode !== "restoring" || state.maintenance_id !== input.maintenance_id) throw new ApiError(409, "RESTORE_MODE_MISMATCH", "恢复维护状态不匹配");
  const calculated = await sha256(JSON.stringify(input.items));
  if (calculated !== input.checksum) throw new ApiError(409, "RESTORE_CHECKSUM_MISMATCH", "恢复批次校验和不一致");
  const existing = await c.env.DB.prepare("SELECT checksum FROM uranus_restore_batches WHERE backup_id=? AND batch_id=?").bind(input.backup_id, input.batch_id).first<{ checksum: string }>();
  if (existing) {
    if (existing.checksum !== input.checksum) throw new ApiError(409, "RESTORE_BATCH_MISMATCH", "恢复批次 id 已用于不同内容");
    return c.json({ restored: true, replayed: true });
  }
  if (input.entity === "finalize") {
    const integrity = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM uranus_notes) AS notes, (SELECT COUNT(*) FROM uranus_note_search) AS searched, (SELECT COUNT(*) FROM uranus_attachments WHERE status<>'ready') AS incomplete_attachments, (SELECT COUNT(*) FROM uranus_attachment_refs r JOIN uranus_attachments a ON a.id=r.attachment_id WHERE r.note_id<>a.note_id) AS cross_note_refs").first<{ notes: number; searched: number; incomplete_attachments: number; cross_note_refs: number }>();
    if (!integrity || integrity.notes !== integrity.searched || integrity.incomplete_attachments !== 0 || integrity.cross_note_refs !== 0) throw new ApiError(409, "RESTORE_INCOMPLETE", "恢复数据尚未通过完整性检查");
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO uranus_restore_batches(backup_id,batch_id,checksum,entity,created_at) VALUES (?,?,?,?,?)").bind(input.backup_id, input.batch_id, input.checksum, input.entity, Date.now()),
      c.env.DB.prepare("UPDATE uranus_runtime_state SET mode='frozen' WHERE id=1 AND mode='restoring' AND maintenance_id=?").bind(input.maintenance_id),
    ]);
    return c.json({ restored: true, finalized: true, integrity });
  }
  const statements: D1PreparedStatement[] = [];
  for (const item of input.items) {
    if (["notes", "versions"].includes(input.entity) && item.content_schema_version !== undefined && ![1, 2].includes(Number(item.content_schema_version))) throw new ApiError(400, "UNSUPPORTED_CONTENT_SCHEMA", "备份正文版本不受支持");
    if (input.entity === "folders") {
      const id = Number(item.id); const systemKey = item.system_key === "default" ? "default" : null;
      if (systemKey === "default") {
        if (id !== 1) throw new ApiError(409, "RESTORE_DEFAULT_FOLDER_MISMATCH", "默认文件夹 id 不兼容");
        statements.push(c.env.DB.prepare("UPDATE uranus_folders SET name=?, updated_at=? WHERE id=1 AND system_key='default'").bind(String(item.name), Number(item.updated_at)));
      } else statements.push(c.env.DB.prepare("INSERT INTO uranus_folders(id,name,system_key,created_at,updated_at) VALUES (?,?,NULL,?,?)").bind(id, String(item.name), Number(item.created_at), Number(item.updated_at)));
    } else if (input.entity === "notes") {
      const contentJson = String(item.content_json); validateAndDeriveContent(JSON.parse(contentJson));
      statements.push(c.env.DB.prepare("INSERT INTO uranus_notes(id,folder_id,prev_folder_id,title,snippet,content_json,content_schema_version,revision,pinned,starred,deleted_at,purge_pending,last_operation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,2,?,?,?,?,0,?,?,?)").bind(Number(item.id), Number(item.folder_id), item.prev_folder_id == null ? null : Number(item.prev_folder_id), String(item.title), String(item.snippet), contentJson, Number(item.revision), Number(item.pinned), Number(item.starred), item.deleted_at == null ? null : Number(item.deleted_at), `restore:${input.backup_id}`, Number(item.created_at), Number(item.updated_at)));
    } else if (input.entity === "versions") {
      const contentJson = String(item.content_json); const derived = validateAndDeriveContent(JSON.parse(contentJson));
      statements.push(c.env.DB.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES (?,?,?,1,2,?,?,?,?)").bind(Number(item.id), Number(item.note_id), contentJson, String(item.title), derived.charCount, Number(item.source_revision), Number(item.created_at)));
    } else if (input.entity === "attachments") {
      const objectKey = String(item.object_key); const id = String(item.id); const noteId = Number(item.note_id);
      if (!objectKey.startsWith(`uranus/attachments/${noteId}/${id}.`)) throw new ApiError(400, "INVALID_OBJECT_KEY", "备份中的附件键不属于目标笔记");
      statements.push(c.env.DB.prepare("INSERT INTO uranus_attachments(id,note_id,object_key,file_name,mime,size,etag,status,unreferenced_at,created_at,updated_at,last_error_code) VALUES (?,?,?,?,?,?,NULL,'pending',?,?,?,NULL)").bind(id, noteId, objectKey, String(item.file_name), String(item.mime), Number(item.size), item.unreferenced_at == null ? null : Number(item.unreferenced_at), Number(item.created_at), Number(item.updated_at)));
    } else if (input.entity === "refs") {
      statements.push(c.env.DB.prepare("INSERT INTO uranus_attachment_refs(attachment_id,note_id,version_id) VALUES (?,?,?)").bind(String(item.attachment_id), Number(item.note_id), item.version_id == null ? null : Number(item.version_id)));
    } else if (input.entity === "search") {
      const noteId = Number(item.note_id);
      const note = await c.env.DB.prepare("SELECT content_json, revision FROM uranus_notes WHERE id=?").bind(noteId).first<{ content_json: string; revision: number }>();
      if (!note) throw new ApiError(409, "RESTORE_NOTE_MISSING", "搜索重建引用了不存在的笔记");
      const derived = validateAndDeriveContent(JSON.parse(note.content_json));
      statements.push(c.env.DB.prepare("INSERT INTO uranus_note_search(note_id,normalized_title,normalized_text,source_revision) VALUES (?,?,?,?)").bind(noteId, derived.normalizedTitle, derived.normalizedText, note.revision));
    }
  }
  statements.push(c.env.DB.prepare("INSERT INTO uranus_restore_batches(backup_id,batch_id,checksum,entity,created_at) VALUES (?,?,?,?,?)").bind(input.backup_id, input.batch_id, input.checksum, input.entity, Date.now()));
  await c.env.DB.batch(statements);
  return c.json({ restored: true, count: input.items.length });
});

maintenanceRoutes.get("/attachments", async (c) => {
  const cursor = Math.max(0, Number(c.req.query("cursor") ?? 0));
  const rows = await c.env.DB.prepare("SELECT rowid AS cursor, id, object_key, size, etag, status FROM uranus_attachments WHERE rowid>? ORDER BY rowid LIMIT 21").bind(cursor).all<{ cursor: number; id: string; object_key: string; size: number; etag: string | null; status: string }>();
  const items = [];
  for (const row of rows.results.slice(0, 20)) {
    const object = await c.env.UPLOADS.head(row.object_key);
    items.push({ attachmentId: row.id, status: row.status, issue: !object ? "OBJECT_MISSING" : object.size !== row.size ? "SIZE_MISMATCH" : null });
  }
  return c.json({ items, cursor: rows.results.length > 20 ? rows.results[19]?.cursor ?? null : null });
});
maintenanceRoutes.get("/jobs/:id", async (c) => c.json(await getJob(c.env.DB, c.req.param("id"))));
maintenanceRoutes.post("/jobs/:id/retry", async (c) => {
  const parsed = z.object({ operation_id: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "重试请求无效");
  const result = await c.env.DB.prepare("UPDATE uranus_maintenance_jobs SET status='queued', attempt=0, next_attempt_at=?, last_error_code=NULL, updated_at=? WHERE id=? AND status='failed'").bind(Date.now(), Date.now(), c.req.param("id")).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "JOB_NOT_RETRYABLE", "任务不存在或当前不可重试");
  return c.json(await getJob(c.env.DB, c.req.param("id")));
});
