import type { FolderDto } from "../../shared/dto";
import { ApiError } from "../lib/http";
import { randomSafeInteger } from "../lib/crypto";
import type { AccountSession } from "./accountSessions";
import { businessWrite } from "./businessWrite";

export async function listFolders(db: D1Database, session?: AccountSession): Promise<FolderDto[]> {
  const result = await db.prepare("SELECT f.id, f.name, f.system_key, COUNT(n.id) AS note_count FROM uranus_folders f LEFT JOIN uranus_notes n ON n.folder_id = f.id AND n.user_id IS f.user_id AND n.deleted_at IS NULL AND n.purge_pending = 0 WHERE f.user_id IS ? GROUP BY f.id ORDER BY f.system_key = 'default' DESC, f.name COLLATE NOCASE, f.id").bind(session?.user.id ?? null).all<{ id: number; name: string; system_key: "default" | null; note_count: number }>();
  return result.results.map((row) => ({ id: row.id, name: row.name, systemKey: row.system_key, noteCount: row.note_count }));
}

export async function createFolder(db: D1Database, name: string, session?: AccountSession): Promise<FolderDto> {
  const id = randomSafeInteger();
  const now = Date.now();
  try {
    await businessWrite(db, session, [db.prepare("INSERT INTO uranus_folders(id, name, created_at, updated_at, user_id) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(id, name, now, now, session?.user.id ?? null)]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed")) throw error;
    throw new ApiError(409, "FOLDER_NAME_CONFLICT", "文件夹名称已存在");
  }
  const folder = (await listFolders(db, session)).find((item) => item.id === id);
  if (!folder) throw new ApiError(503, "MAINTENANCE_MODE", "维护期间暂停写入");
  return folder;
}

export async function renameFolder(db: D1Database, id: number, name: string, session?: AccountSession) {
  const folder = await db.prepare("SELECT system_key FROM uranus_folders WHERE id=? AND user_id IS ?").bind(id, session?.user.id ?? null).first<{ system_key: string | null }>();
  if (!folder) throw new ApiError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  try {
    await businessWrite(db, session, [db.prepare("UPDATE uranus_folders SET name=?, updated_at=? WHERE id=? AND user_id IS ? AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(name, Date.now(), id, session?.user.id ?? null)]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed")) throw error;
    throw new ApiError(409, "FOLDER_NAME_CONFLICT", "文件夹名称已存在");
  }
  return (await listFolders(db, session)).find((item) => item.id === id);
}

export async function deleteFolder(db: D1Database, id: number, session?: AccountSession) {
  const folder = await db.prepare("SELECT system_key FROM uranus_folders WHERE id=? AND user_id IS ?").bind(id, session?.user.id ?? null).first<{ system_key: string | null }>();
  if (!folder) throw new ApiError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
  if (folder.system_key === "default") throw new ApiError(409, "DEFAULT_FOLDER", "默认文件夹不可删除");
  const defaultFolder = await db.prepare("SELECT id FROM uranus_folders WHERE system_key='default' AND user_id IS ?").bind(session?.user.id ?? null).first<{ id: number }>();
  if (!defaultFolder) throw new ApiError(500, "DEFAULT_FOLDER_MISSING", "默认文件夹缺失");
  const now = Date.now();
  await businessWrite(db, session, [
    db.prepare("UPDATE uranus_notes SET prev_folder_id=folder_id, folder_id=?, deleted_at=COALESCE(deleted_at,?), revision=revision+1, updated_at=? WHERE folder_id=? AND user_id IS ? AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(defaultFolder.id, now, now, id, session?.user.id ?? null),
    db.prepare("DELETE FROM uranus_folders WHERE id=? AND user_id IS ? AND NOT EXISTS (SELECT 1 FROM uranus_notes WHERE folder_id=?) AND EXISTS (SELECT 1 FROM uranus_runtime_state WHERE id=1 AND mode='normal')").bind(id, session?.user.id ?? null, id),
  ]);
  return { deleted: true };
}
