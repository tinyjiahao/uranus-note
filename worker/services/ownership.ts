import type { AccountSession } from "./accountSessions";
import { ApiError } from "../lib/http";

// Fixed server-defined SQL only; request-provided table names or owner IDs are
// never interpolated. These checks must run BEFORE ETag/Range or replay lookup.
const queries = {
  note: "SELECT id FROM uranus_notes WHERE id=? AND user_id=? AND purge_pending=0",
  folder: "SELECT id FROM uranus_folders WHERE id=? AND user_id=?",
  attachment: `SELECT a.id FROM uranus_attachments a JOIN uranus_notes n ON n.id=a.note_id
    WHERE a.id=? AND n.user_id=? AND n.purge_pending=0`,
  version: `SELECT v.id FROM uranus_note_versions v JOIN uranus_notes n ON n.id=v.note_id
    WHERE v.id=? AND n.user_id=? AND n.purge_pending=0`,
  operation: "SELECT operation_id FROM uranus_operations WHERE operation_id=? AND user_id=?",
  job: "SELECT id FROM uranus_maintenance_jobs WHERE id=? AND user_id=?",
} as const;

/** A preflight, not a replacement for owner predicates on final writes. */
export async function assertOwnedResource(db: D1Database, session: AccountSession,
  resource: keyof typeof queries, id: string | number): Promise<void> {
  const row = await db.prepare(queries[resource]).bind(id, session.user.id).first();
  if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "资源不存在或无权访问");
}
