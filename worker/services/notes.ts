import { EMPTY_CONTENT, type ContentNode, type NoteDetail, type NoteListItem, type PageDto } from "../../shared/dto";
import { normalizeSearch, validateAndDeriveContent, validateSearchQuery } from "../../shared/content";
import { ApiError } from "../lib/http";
import { randomSafeInteger, requestHash } from "../lib/crypto";
import { existingOperation, validateOperationId } from "./operations";

type NoteRow = {
  id: number; folder_id: number; title: string; snippet: string; content_json: string;
  content_schema_version: number; revision: number; pinned: number; starred: number;
  deleted_at: number | null; created_at: number; updated_at: number;
};

function listItem(row: NoteRow): NoteListItem {
  return {
    id: row.id, folderId: row.folder_id, title: row.title, snippet: row.snippet, revision: row.revision,
    pinned: row.pinned === 1, starred: row.starred === 1, deletedAt: row.deleted_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function detail(row: NoteRow): NoteDetail {
  if (row.content_schema_version !== 1 && row.content_schema_version !== 2 && row.content_schema_version !== 3 && row.content_schema_version !== 4) throw new ApiError(400, "UNSUPPORTED_CONTENT_SCHEMA", "请刷新应用以支持此正文版本");
  return { ...listItem(row), content: JSON.parse(row.content_json) as ContentNode, contentSchemaVersion: row.content_schema_version };
}

export async function getNote(db: D1Database, id: number): Promise<NoteDetail> {
  const row = await db.prepare("SELECT id, folder_id, title, snippet, content_json, content_schema_version, revision, pinned, starred, deleted_at, created_at, updated_at FROM uranus_notes WHERE id = ? AND purge_pending = 0").bind(id).first<NoteRow>();
  if (!row) throw new ApiError(404, "NOTE_NOT_FOUND", "笔记不存在");
  return detail(row);
}

export type ListOptions = { folderId?: number | undefined; starred?: boolean | undefined; deleted?: boolean | undefined; q?: string | undefined; sortBy?: string | undefined; sortDir?: string | undefined; page?: number | undefined; pageSize?: number | undefined };

export async function listNotes(db: D1Database, options: ListOptions): Promise<PageDto<NoteListItem>> {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError(400, "INVALID_PAGE", "分页参数无效");
  const sortColumns: Record<string, string> = { updated_at: "n.updated_at", created_at: "n.created_at", title: "n.title" };
  const sortBy = sortColumns[options.sortBy ?? "updated_at"];
  if (!sortBy) throw new ApiError(400, "INVALID_SORT", "不支持的排序字段");
  const direction = (options.sortDir ?? "desc").toLowerCase();
  if (direction !== "asc" && direction !== "desc") throw new ApiError(400, "INVALID_SORT", "不支持的排序方向");
  const where = ["n.purge_pending = 0", options.deleted ? "n.deleted_at IS NOT NULL" : "n.deleted_at IS NULL"];
  const bindings: unknown[] = [];
  if (options.folderId !== undefined) { where.push("n.folder_id = ?"); bindings.push(options.folderId); }
  if (options.starred) where.push("n.starred = 1");
  let join = "";
  if (options.q?.trim()) {
    const query = validateSearchQuery(options.q);
    join = "JOIN uranus_note_search s ON s.note_id = n.id";
    where.push("(instr(s.normalized_title, ?) > 0 OR instr(s.normalized_text, ?) > 0)");
    bindings.push(query, query);
  }
  const order = `n.pinned DESC, ${options.sortBy === "title" ? "CASE WHEN n.title = '' THEN 1 ELSE 0 END ASC," : ""} ${sortBy} ${direction.toUpperCase()}, n.id ASC`;
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM uranus_notes n ${join} WHERE ${where.join(" AND ")}`).bind(...bindings).first<{ count: number }>();
  const sql = `SELECT n.id, n.folder_id, n.title, n.snippet, n.revision, n.pinned, n.starred, n.deleted_at, n.created_at, n.updated_at FROM uranus_notes n ${join} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`;
  bindings.push(pageSize + 1, (page - 1) * pageSize);
  const result = await db.prepare(sql).bind(...bindings).all<NoteRow>();
  const rows = result.results;
  return { items: rows.slice(0, pageSize).map(listItem), page, pageSize, hasMore: rows.length > pageSize, totalCount: count?.count ?? 0 };
}

type CreateInput = { operation_id: string; folder_id?: number | undefined; content_schema_version: 1 | 2 | 3 | 4; content?: Record<string, unknown> | undefined };

export async function createNote(db: D1Database, input: CreateInput) {
  validateOperationId(input.operation_id);
  const hash = await requestHash("POST", "/api/notes", input);
  const existing = await existingOperation(db, input.operation_id, hash);
  if (existing) {
    if (existing.status === "succeeded" && existing.result_id) return getNote(db, Number(existing.result_id));
    throw new ApiError(existing.status === "pending" ? 202 : 409, existing.result_code ?? "OPERATION_PENDING", existing.status === "pending" ? "操作仍在进行" : "操作已失败");
  }
  const folder = input.folder_id === undefined
    ? await db.prepare("SELECT id FROM uranus_folders WHERE system_key = 'default'").first<{ id: number }>()
    : await db.prepare("SELECT id FROM uranus_folders WHERE id = ?").bind(input.folder_id).first<{ id: number }>();
  if (!folder) throw new ApiError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  const derived = validateAndDeriveContent(input.content ?? EMPTY_CONTENT, input.content_schema_version);
  const id = randomSafeInteger();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at) VALUES (?, 'note.create', ?, 'pending', ?, ?)").bind(input.operation_id, hash, now, now + 604_800_000),
    db.prepare("INSERT INTO uranus_notes(id, folder_id, title, snippet, content_json, content_schema_version, revision, last_operation_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id = 1 AND mode = 'normal')").bind(id, folder.id, derived.title, derived.snippet, derived.serialized, input.content_schema_version, input.operation_id, now, now),
    db.prepare("INSERT INTO uranus_note_search(note_id, normalized_title, normalized_text, source_revision) SELECT id, ?, ?, 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?").bind(derived.normalizedTitle, derived.normalizedText, id, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status = 'succeeded', result_id = ?, result_revision = 1 WHERE operation_id = ? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(String(id), input.operation_id, id, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status = 'failed', result_code = 'MAINTENANCE_MODE' WHERE operation_id = ? AND status = 'pending'").bind(input.operation_id),
  ]);
  const operation = await existingOperation(db, input.operation_id, hash);
  if (operation?.status !== "succeeded") throw new ApiError(503, operation?.result_code ?? "WRITE_FAILED", "维护期间暂停写入");
  return getNote(db, id);
}

export type PatchInput = {
  operation_id: string; expected_revision: number; content_schema_version?: 1 | 2 | 3 | 4 | undefined; content?: Record<string, unknown> | undefined;
  folder_id?: number | undefined; pinned?: boolean | undefined; starred?: boolean | undefined;
};

export async function patchNote(db: D1Database, id: number, input: PatchInput) {
  validateOperationId(input.operation_id);
  const hash = await requestHash("PATCH", `/api/notes/${id}`, input);
  const replay = await existingOperation(db, input.operation_id, hash);
  if (replay) {
    if (replay.status === "succeeded") return { note: await getNote(db, id), operation_id: input.operation_id, applied_revision: replay.result_revision };
    if (replay.status === "pending") throw new ApiError(202, "OPERATION_PENDING", "操作仍在进行");
    throw new ApiError(409, replay.result_code ?? "REVISION_CONFLICT", "该操作此前已失败", { latest: await getNote(db, id) });
  }
  const current = await getNote(db, id);
  if (current.contentSchemaVersion > (input.content_schema_version ?? 1)) throw new ApiError(409, "CLIENT_UPDATE_REQUIRED", "此笔记使用新版格式，请刷新页面后重试");
  if (current.deletedAt !== null) throw new ApiError(409, "NOTE_IN_TRASH", "请先恢复笔记再编辑");
  if (input.folder_id !== undefined) {
    const folder = await db.prepare("SELECT id FROM uranus_folders WHERE id = ?").bind(input.folder_id).first();
    if (!folder) throw new ApiError(404, "FOLDER_NOT_FOUND", "目标文件夹不存在");
  }
  const content = input.content ?? current.content as Record<string, unknown>;
  const derived = validateAndDeriveContent(content, input.content_schema_version ?? current.contentSchemaVersion);
  const contentChanged = derived.serialized !== JSON.stringify(current.content);
  if (derived.attachmentIds.length) {
    const placeholders = derived.attachmentIds.map(() => "?").join(",");
    const attached = await db.prepare(`SELECT COUNT(*) AS count FROM uranus_attachments WHERE note_id = ? AND status = 'ready' AND id IN (${placeholders})`).bind(id, ...derived.attachmentIds).first<{ count: number }>();
    if (attached?.count !== derived.attachmentIds.length) throw new ApiError(400, "INVALID_ATTACHMENT", "正文包含不可用或属于其他笔记的附件");
  }
  const revision = input.expected_revision + 1;
  const now = Date.now();
  const versionId = randomSafeInteger();
  const folderId = input.folder_id ?? current.folderId;
  const pinned = input.pinned ?? current.pinned;
  const starred = input.starred ?? current.starred;
  const attachmentIds = derived.attachmentIds;
  const attachmentGuard = attachmentIds.length
    ? ` AND (SELECT COUNT(*) FROM uranus_attachments a WHERE a.note_id = ? AND a.status = 'ready' AND a.id IN (${attachmentIds.map(() => "?").join(",")})) = ?`
    : "";
  const updateBindings: unknown[] = [folderId, derived.title, derived.snippet, derived.serialized, Math.max(2, input.content_schema_version ?? current.contentSchemaVersion), revision, pinned ? 1 : 0, starred ? 1 : 0, input.operation_id, now, id, input.expected_revision];
  if (attachmentIds.length) updateBindings.push(id, ...attachmentIds, attachmentIds.length);
  const statements = [
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at) VALUES (?, 'note.patch', ?, 'pending', ?, ?)").bind(input.operation_id, hash, now, now + 604_800_000),
    db.prepare(`UPDATE uranus_notes SET folder_id = ?, title = ?, snippet = ?, content_json = ?, content_schema_version = ?, revision = ?, pinned = ?, starred = ?, last_operation_id = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL AND purge_pending = 0 AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id = 1 AND mode = 'normal')${attachmentGuard}`).bind(...updateBindings),
    db.prepare("INSERT INTO uranus_note_search(note_id, normalized_title, normalized_text, source_revision) SELECT id, ?, ?, revision FROM uranus_notes WHERE id = ? AND last_operation_id = ? ON CONFLICT(note_id) DO UPDATE SET normalized_title = excluded.normalized_title, normalized_text = excluded.normalized_text, source_revision = excluded.source_revision").bind(derived.normalizedTitle, derived.normalizedText, id, input.operation_id),
  ];
  if (contentChanged) {
    statements.push(db.prepare("DELETE FROM uranus_attachment_refs WHERE note_id = ? AND version_id IS NULL AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(id, id, input.operation_id));
    for (const attachmentId of attachmentIds) {
      statements.push(db.prepare("INSERT INTO uranus_attachment_refs(attachment_id, note_id, version_id) SELECT id, note_id, NULL FROM uranus_attachments WHERE id = ? AND note_id = ? AND status = 'ready' AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(attachmentId, id, id, input.operation_id));
      statements.push(db.prepare("UPDATE uranus_attachments SET unreferenced_at = NULL, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(now, attachmentId, id, input.operation_id));
    }
  }
  if (contentChanged) {
    statements.push(db.prepare("INSERT INTO uranus_note_versions(id, note_id, content_json, content_schema_v1, content_schema_version, title, char_count, source_revision, created_at) SELECT ?, id, content_json, 1, content_schema_version, title, ?, revision, ? FROM uranus_notes WHERE id = ? AND last_operation_id = ? AND NOT EXISTS (SELECT 1 FROM uranus_note_versions WHERE note_id = ? AND created_at > ?)").bind(versionId, derived.charCount, now, id, input.operation_id, id, now - 300_000));
    for (const attachmentId of attachmentIds) {
      statements.push(db.prepare("INSERT INTO uranus_attachment_refs(attachment_id, note_id, version_id) SELECT ?, ?, id FROM uranus_note_versions WHERE id = ? ON CONFLICT DO NOTHING").bind(attachmentId, id, versionId));
    }
    statements.push(db.prepare("DELETE FROM uranus_note_versions WHERE note_id = ? AND id NOT IN (SELECT id FROM uranus_note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 30) AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(id, id, id, input.operation_id));
    statements.push(db.prepare("UPDATE uranus_attachments SET unreferenced_at = COALESCE(unreferenced_at, ?), updated_at = ? WHERE note_id = ? AND status = 'ready' AND NOT EXISTS (SELECT 1 FROM uranus_attachment_refs r WHERE r.attachment_id = uranus_attachments.id) AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(now, now, id, id, input.operation_id));
  }
  statements.push(
    db.prepare("UPDATE uranus_operations SET status = 'succeeded', result_id = ?, result_revision = ? WHERE operation_id = ? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(String(id), revision, input.operation_id, id, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status = 'failed', result_code = CASE WHEN EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id = 1 AND mode <> 'normal') THEN 'MAINTENANCE_MODE' ELSE 'REVISION_CONFLICT' END WHERE operation_id = ? AND status = 'pending'").bind(input.operation_id),
  );
  await db.batch(statements);
  const operation = await existingOperation(db, input.operation_id, hash);
  if (operation?.status !== "succeeded") {
    if (operation?.result_code === "MAINTENANCE_MODE") throw new ApiError(503, "MAINTENANCE_MODE", "维护期间暂停写入");
    throw new ApiError(409, "REVISION_CONFLICT", "笔记已在其他位置更新", { latest: await getNote(db, id) });
  }
  return { note: await getNote(db, id), operation_id: input.operation_id, applied_revision: revision };
}

export async function changeDeletedState(db: D1Database, id: number, input: { operation_id: string; expected_revision: number }, restore: boolean) {
  validateOperationId(input.operation_id);
  const path = restore ? `/api/notes/${id}/restore` : `/api/notes/${id}`;
  const hash = await requestHash(restore ? "POST" : "DELETE", path, input);
  const replay = await existingOperation(db, input.operation_id, hash);
  if (replay?.status === "succeeded") return getNote(db, id);
  if (replay) throw new ApiError(replay.status === "pending" ? 202 : 409, replay.result_code ?? "OPERATION_PENDING", "操作未完成");
  const current = await getNote(db, id);
  const now = Date.now();
  const revision = input.expected_revision + 1;
  const defaultFolder = restore ? await db.prepare("SELECT id FROM uranus_folders WHERE system_key = 'default'").first<{ id: number }>() : null;
  const targetFolder = restore
    ? ((await db.prepare("SELECT f.id FROM uranus_notes n JOIN uranus_folders f ON f.id = n.prev_folder_id WHERE n.id = ?").bind(id).first<{ id: number }>())?.id ?? defaultFolder?.id)
    : current.folderId;
  await db.batch([
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)").bind(input.operation_id, restore ? "note.restore" : "note.delete", hash, now, now + 604_800_000),
    restore
      ? db.prepare("UPDATE uranus_notes SET folder_id = ?, prev_folder_id = NULL, deleted_at = NULL, revision = ?, last_operation_id = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL AND purge_pending = 0 AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(targetFolder, revision, input.operation_id, now, id, input.expected_revision)
      : db.prepare("UPDATE uranus_notes SET prev_folder_id = folder_id, deleted_at = ?, revision = ?, last_operation_id = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL AND purge_pending = 0 AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(now, revision, input.operation_id, now, id, input.expected_revision),
    db.prepare("UPDATE uranus_note_search SET source_revision = ? WHERE note_id = ? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id = ? AND last_operation_id = ?)").bind(revision, id, id, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=?, result_revision=? WHERE operation_id=? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=?)").bind(String(id), revision, input.operation_id, id, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status='failed', result_code='REVISION_CONFLICT' WHERE operation_id=? AND status='pending'").bind(input.operation_id),
  ]);
  const operation = await existingOperation(db, input.operation_id, hash);
  if (operation?.status !== "succeeded") throw new ApiError(409, "REVISION_CONFLICT", "笔记已在其他位置更新", { latest: await getNote(db, id) });
  return getNote(db, id);
}

export async function listVersions(db: D1Database, noteId: number, page: number, pageSize: number) {
  await getNote(db, noteId);
  const safePage = Math.max(1, page);
  const safeSize = Math.min(100, Math.max(1, pageSize));
  const result = await db.prepare("SELECT id, note_id, content_schema_version, title, char_count, source_revision, created_at FROM uranus_note_versions WHERE note_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").bind(noteId, safeSize + 1, (safePage - 1) * safeSize).all();
  return { items: result.results.slice(0, safeSize), page: safePage, pageSize: safeSize, hasMore: result.results.length > safeSize };
}

export async function getVersion(db: D1Database, noteId: number, versionId: number) {
  const row = await db.prepare("SELECT id, note_id, content_json, content_schema_version, title, char_count, source_revision, created_at FROM uranus_note_versions WHERE id = ? AND note_id = ?").bind(versionId, noteId).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "VERSION_NOT_FOUND", "版本不存在");
  if (![1, 2, 3, 4].includes(Number(row.content_schema_version))) throw new ApiError(400, "UNSUPPORTED_CONTENT_SCHEMA", "历史正文版本不受支持");
  return { ...row, id: Number(row.id), content: JSON.parse(String(row.content_json)), content_json: undefined };
}

export async function createManualVersion(db: D1Database, noteId: number, operationId: string) {
  validateOperationId(operationId);
  const hash = await requestHash("POST", `/api/notes/${noteId}/versions`, { operation_id: operationId });
  const replay = await existingOperation(db, operationId, hash);
  if (replay?.status === "succeeded" && replay.result_id) return getVersion(db, noteId, Number(replay.result_id));
  if (replay) throw new ApiError(replay.status === "pending" ? 202 : 409, replay.result_code ?? "VERSION_FAILED", "版本操作未完成");
  const note = await getNote(db, noteId);
  if (note.deletedAt !== null) throw new ApiError(409, "NOTE_IN_TRASH", "回收站中的笔记不能创建版本");
  const derived = validateAndDeriveContent(note.content);
  const latest = await db.prepare("SELECT id, content_json FROM uranus_note_versions WHERE note_id=? ORDER BY id DESC LIMIT 1").bind(noteId).first<{ id: number; content_json: string }>();
  const versionId = latest?.content_json === derived.serialized ? latest.id : randomSafeInteger();
  const now = Date.now();
  const statements = [db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at) VALUES (?, 'version.create', ?, 'pending', ?, ?)").bind(operationId, hash, now, now + 604_800_000)];
  if (latest?.content_json !== derived.serialized) {
    statements.push(db.prepare("INSERT INTO uranus_note_versions(id, note_id, content_json, content_schema_v1, content_schema_version, title, char_count, source_revision, created_at) SELECT ?, id, content_json, 1, content_schema_version, title, ?, revision, ? FROM uranus_notes WHERE id=? AND revision=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(versionId, derived.charCount, now, noteId, note.revision));
    for (const attachmentId of derived.attachmentIds) statements.push(db.prepare("INSERT INTO uranus_attachment_refs(attachment_id, note_id, version_id) SELECT ?, ?, id FROM uranus_note_versions WHERE id=? ON CONFLICT DO NOTHING").bind(attachmentId, noteId, versionId));
    statements.push(db.prepare("DELETE FROM uranus_note_versions WHERE note_id=? AND id NOT IN (SELECT id FROM uranus_note_versions WHERE note_id=? ORDER BY id DESC LIMIT 30)").bind(noteId, noteId));
  }
  statements.push(
    db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=?, result_revision=? WHERE operation_id=? AND EXISTS (SELECT 1 FROM uranus_note_versions WHERE id=?)").bind(String(versionId), note.revision, operationId, versionId),
    db.prepare("UPDATE uranus_operations SET status='failed', result_code='VERSION_FAILED' WHERE operation_id=? AND status='pending'").bind(operationId),
  );
  await db.batch(statements);
  const operation = await existingOperation(db, operationId, hash);
  if (operation?.status !== "succeeded") throw new ApiError(409, "VERSION_FAILED", "创建版本失败，笔记可能已发生变化");
  return getVersion(db, noteId, versionId);
}

export async function restoreVersion(db: D1Database, noteId: number, versionId: number, input: { operation_id: string; expected_revision: number }) {
  validateOperationId(input.operation_id);
  const hash = await requestHash("POST", `/api/notes/${noteId}/versions/${versionId}/restore`, input);
  const replay = await existingOperation(db, input.operation_id, hash);
  if (replay?.status === "succeeded") return getNote(db, noteId);
  if (replay) throw new ApiError(replay.status === "pending" ? 202 : 409, replay.result_code ?? "RESTORE_FAILED", "恢复操作未完成");
  const current = await getNote(db, noteId);
  if (current.deletedAt !== null) throw new ApiError(409, "NOTE_IN_TRASH", "请先恢复笔记");
  const versionRow = await db.prepare("SELECT content_json, content_schema_version FROM uranus_note_versions WHERE id=? AND note_id=?").bind(versionId, noteId).first<{ content_json: string; content_schema_version: number }>();
  if (!versionRow) throw new ApiError(404, "VERSION_NOT_FOUND", "版本不存在");
  if (![1, 2, 3, 4].includes(versionRow.content_schema_version)) throw new ApiError(400, "UNSUPPORTED_CONTENT_SCHEMA", "该版本正文无法由当前应用恢复");
  const restoredContent = JSON.parse(versionRow.content_json) as Record<string, unknown>;
  const restored = validateAndDeriveContent(restoredContent);
  const currentDerived = validateAndDeriveContent(current.content);
  const restoredSchemaVersion = Math.max(2, current.contentSchemaVersion, versionRow.content_schema_version);
  const same = restored.serialized === currentDerived.serialized && current.contentSchemaVersion === restoredSchemaVersion;
  const newRevision = same ? current.revision : input.expected_revision + 1;
  const backupId = randomSafeInteger();
  const now = Date.now();
  const statements = [
    db.prepare("INSERT INTO uranus_operations(operation_id, scope, request_hash, status, created_at, expires_at) VALUES (?, 'version.restore', ?, 'pending', ?, ?)").bind(input.operation_id, hash, now, now + 604_800_000),
  ];
  if (!same) {
    statements.push(db.prepare("INSERT INTO uranus_note_versions(id, note_id, content_json, content_schema_v1, content_schema_version, title, char_count, source_revision, created_at) SELECT ?, id, content_json, 1, content_schema_version, title, ?, revision, ? FROM uranus_notes WHERE id=? AND revision=? AND deleted_at IS NULL").bind(backupId, currentDerived.charCount, now, noteId, input.expected_revision));
    for (const attachmentId of currentDerived.attachmentIds) statements.push(db.prepare("INSERT INTO uranus_attachment_refs(attachment_id, note_id, version_id) SELECT ?, ?, id FROM uranus_note_versions WHERE id=? ON CONFLICT DO NOTHING").bind(attachmentId, noteId, backupId));
    statements.push(
      db.prepare("UPDATE uranus_notes SET title=?, snippet=?, content_json=?, content_schema_version=?, revision=?, last_operation_id=?, updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(restored.title, restored.snippet, restored.serialized, restoredSchemaVersion, newRevision, input.operation_id, now, noteId, input.expected_revision),
      db.prepare("UPDATE uranus_note_search SET normalized_title=?, normalized_text=?, source_revision=? WHERE note_id=? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=?)").bind(restored.normalizedTitle, restored.normalizedText, newRevision, noteId, noteId, input.operation_id),
      db.prepare("DELETE FROM uranus_attachment_refs WHERE note_id=? AND version_id IS NULL AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=?)").bind(noteId, noteId, input.operation_id),
    );
    for (const attachmentId of restored.attachmentIds) statements.push(db.prepare("INSERT INTO uranus_attachment_refs(attachment_id, note_id, version_id) SELECT id, note_id, NULL FROM uranus_attachments WHERE id=? AND note_id=? AND status='ready' AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=?)").bind(attachmentId, noteId, noteId, input.operation_id));
    statements.push(db.prepare("DELETE FROM uranus_note_versions WHERE note_id=? AND id NOT IN (SELECT id FROM uranus_note_versions WHERE note_id=? ORDER BY id DESC LIMIT 30) AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=?)").bind(noteId, noteId, noteId, input.operation_id));
  }
  statements.push(
    same
      ? db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=?, result_revision=? WHERE operation_id=?").bind(String(noteId), current.revision, input.operation_id)
      : db.prepare("UPDATE uranus_operations SET status='succeeded', result_id=?, result_revision=? WHERE operation_id=? AND EXISTS (SELECT 1 FROM uranus_notes WHERE id=? AND last_operation_id=?)").bind(String(noteId), newRevision, input.operation_id, noteId, input.operation_id),
    db.prepare("UPDATE uranus_operations SET status='failed', result_code='REVISION_CONFLICT' WHERE operation_id=? AND status='pending'").bind(input.operation_id),
  );
  await db.batch(statements);
  const operation = await existingOperation(db, input.operation_id, hash);
  if (operation?.status !== "succeeded") throw new ApiError(409, "REVISION_CONFLICT", "笔记已在其他位置更新", { latest: await getNote(db, noteId) });
  return getNote(db, noteId);
}
