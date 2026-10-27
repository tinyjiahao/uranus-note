import type { ContentNode } from "../../shared/dto";
import { ApiError } from "../lib/http";

// Metadata is immutable after upload; the commit still guards readiness/reference races.
export async function validateFileMetadata(db: D1Database, noteId: number, content: ContentNode) {
  const files: ContentNode[] = [];
  const visit = (node: ContentNode) => { if (node.type === "fileAttachment") files.push(node); node.content?.forEach(visit); };
  visit(content);
  if (!files.length) return;
  const rows = await db.prepare("SELECT id, file_name, mime, size FROM uranus_attachments WHERE note_id=? AND status='ready'").bind(noteId).all<{ id: string; file_name: string; mime: string; size: number }>();
  const byId = new Map(rows.results.map(row => [row.id, row]));
  for (const file of files) {
    const attrs = file.attrs!, row = byId.get(String(attrs.attachmentId));
    if (!row || row.file_name !== attrs.fileName || row.mime !== attrs.mime || row.size !== attrs.size) throw new ApiError(400, "INVALID_ATTACHMENT", "文件附件元数据与所属附件记录不一致");
  }
}
