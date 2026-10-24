import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/http";
import { copyAttachment, deleteAttachment, downloadAttachment, uploadAttachment } from "../services/attachments";
import type { Env, AppVariables } from "../types";

export const attachmentRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
attachmentRoutes.post("/", async (c) => {
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (!Number.isFinite(declared) || declared <= 0) throw new ApiError(411, "CONTENT_LENGTH_REQUIRED", "上传必须提供 Content-Length");
  if (declared > 10_500_000) throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "上传请求超过大小限制");
  const form = await c.req.formData();
  const file = form.get("file");
  const noteId = Number(form.get("note_id"));
  const operationId = String(form.get("operation_id") ?? "");
  if (!(file instanceof File) || !Number.isSafeInteger(noteId) || noteId <= 0) throw new ApiError(400, "VALIDATION_ERROR", "上传字段无效");
  return c.json(await uploadAttachment(c.env.DB, c.env.UPLOADS, noteId, operationId, file), 201);
});

attachmentRoutes.get("/:id", async (c) => {
  const result = await downloadAttachment(c.env.DB, c.env.UPLOADS, c.req.param("id"), c.req.header("If-None-Match"));
  if (result.notModified) return new Response(null, { status: 304, headers: { "Cache-Control": "private, no-cache", ETag: result.row.etag ?? "" } });
  const headers = new Headers({
    "Content-Type": result.row.mime, "Content-Length": String(result.row.size),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(result.row.file_name)}`,
    "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff",
  });
  if (result.row.etag) headers.set("ETag", result.row.etag);
  return new Response(result.object!.body, { headers });
});

attachmentRoutes.delete("/:id", async (c) => c.json(await deleteAttachment(c.env.DB, c.env.UPLOADS, c.req.param("id"))));
attachmentRoutes.post("/:id/copy", async (c) => {
  const parsed = z.object({ target_note_id: z.number().int().positive(), operation_id: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "复制附件请求无效");
  return c.json(await copyAttachment(c.env.DB, c.env.UPLOADS, c.req.param("id"), parsed.data.target_note_id, parsed.data.operation_id), 201);
});
