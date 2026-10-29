import type { NoteStatsDto, StatBucket } from "../../shared/dto";
import type { AccountSession } from "./accountSessions";
import { getNote } from "./notes";

const bucket = (row?: { count: number | null; size: number | null } | null): StatBucket => ({ count: Number(row?.count ?? 0), size: Number(row?.size ?? 0) });

// Read-only summary; ownership is enforced by getNote. Only ready attachments are counted.
export async function getNoteStats(db: D1Database, noteId: number, session?: AccountSession): Promise<NoteStatsDto> {
  await getNote(db, noteId, session);
  const ready = "FROM uranus_attachments a WHERE a.note_id = ? AND a.status = 'ready'";
  const current = "EXISTS(SELECT 1 FROM uranus_attachment_refs r WHERE r.attachment_id = a.id AND r.version_id IS NULL)";
  const history = "EXISTS(SELECT 1 FROM uranus_attachment_refs r WHERE r.attachment_id = a.id AND r.version_id IS NOT NULL)";
  const sum = `SELECT COUNT(*) AS count, COALESCE(SUM(a.size), 0) AS size ${ready}`;
  const [total, images, historyOnly, awaiting, versions] = await db.batch([
    db.prepare(sum).bind(noteId),
    db.prepare(`${sum} AND a.mime LIKE 'image/%'`).bind(noteId),
    db.prepare(`${sum} AND NOT ${current} AND ${history}`).bind(noteId),
    db.prepare(`${sum} AND NOT ${current} AND NOT ${history}`).bind(noteId),
    db.prepare("SELECT COUNT(*) AS count, MAX(created_at) AS latest_at FROM uranus_note_versions WHERE note_id = ?").bind(noteId),
  ]);
  const first = <T>(result: D1Result<unknown> | undefined) => result?.results[0] as T | undefined;
  const all = bucket(first(total)), image = bucket(first(images));
  const version = first<{ count: number; latest_at: number | null }>(versions);
  return {
    attachments: {
      ...all, images: image, files: { count: all.count - image.count, size: all.size - image.size },
      historyOnly: bucket(first(historyOnly)), awaitingCleanup: bucket(first(awaiting)),
    },
    versions: { count: Number(version?.count ?? 0), latestAt: version?.latest_at ?? null },
  };
}
