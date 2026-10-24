import type { FolderDto } from "../../shared/dto";
import { ApiError } from "../lib/http";
import { randomSafeInteger } from "../lib/crypto";

export async function listFolders(db: D1Database): Promise<FolderDto[]> {
  const result = await db.prepare("SELECT f.id, f.name, f.system_key, COUNT(n.id) AS note_count FROM uranus_folders f LEFT JOIN uranus_notes n ON n.folder_id = f.id AND n.deleted_at IS NULL AND n.purge_pending = 0 GROUP BY f.id ORDER BY f.system_key = 'default' DESC, f.name COLLATE NOCASE, f.id").all<{ id: number; name: string; system_key: "default" | null; note_count: number }>();
  return result.results.map((row) => ({ id: row.id, name: row.name, systemKey: row.system_key, noteCount: row.note_count }));
}

export async function createFolder(db: D1Database, name: string): Promise<FolderDto> {
  const id = randomSafeInteger();
  const now = Date.now();
  try {
    await db.prepare("INSERT INTO uranus_folders(id, name, created_at, updated_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(id, name, now, now).run();
  } catch {
    throw new ApiError(409, "FOLDER_NAME_CONFLICT", "文件夹名称已存在");
  }
  const folder = (await listFolders(db)).find((item) => item.id === id);
  if (!folder) throw new ApiError(503, "MAINTENANCE_MODE", "维护期间暂停写入");
  return folder;
}

export async function renameFolder(db: D1Database, id: number, name: string) {
  const folder = await db.prepare("SELECT system_key FROM uranus_folders WHERE id=?").bind(id).first<{ system_key: string | null }>();
  if (!folder) throw new ApiError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  try {
    await db.prepare("UPDATE uranus_folders SET name=?, updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(name, Date.now(), id).run();
  } catch {
    throw new ApiError(409, "FOLDER_NAME_CONFLICT", "文件夹名称已存在");
  }
  return (await listFolders(db)).find((item) => item.id === id);
}

export async function deleteFolder(db: D1Database, id: number) {
  const folder = await db.prepare("SELECT system_key FROM uranus_folders WHERE id=?").bind(id).first<{ system_key: string | null }>();
  if (!folder) throw new ApiError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  if (folder.system_key === "default") throw new ApiError(409, "DEFAULT_FOLDER", "默认文件夹不可删除");
  const defaultFolder = await db.prepare("SELECT id FROM uranus_folders WHERE system_key='default'").first<{ id: number }>();
  if (!defaultFolder) throw new ApiError(500, "DEFAULT_FOLDER_MISSING", "默认文件夹缺失");
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE uranus_notes SET prev_folder_id=folder_id, folder_id=?, deleted_at=?, revision=revision+1, updated_at=? WHERE folder_id=? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(defaultFolder.id, now, now, id),
    db.prepare("DELETE FROM uranus_folders WHERE id=? AND NOT EXISTS (SELECT 1 FROM uranus_notes WHERE folder_id=?) AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(id, id),
  ]);
  return { deleted: true };
}
