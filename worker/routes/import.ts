import { Hono } from "hono";
import { z } from "zod";
import { markdownToContent } from "../../shared/markdown";
import { ApiError } from "../lib/http";
import { createNote } from "../services/notes";
import type { Env, AppVariables } from "../types";

export const importRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
importRoutes.post("/markdown", async (c) => {
  const parsed = z.object({ operation_id: z.string().uuid(), folder_id: z.number().int().positive().optional(), markdown: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Markdown 导入请求无效");
  const content = markdownToContent(parsed.data.markdown) as Record<string, unknown>;
  return c.json(await createNote(c.env.DB, { operation_id: parsed.data.operation_id, folder_id: parsed.data.folder_id, content_schema_version: 2, content }), 201);
});
