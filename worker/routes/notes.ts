import { Hono } from "hono";
import { z } from "zod";
import { createNoteSchema, patchNoteSchema } from "../../shared/validation";
import { ApiError } from "../lib/http";
import { changeDeletedState, createManualVersion, createNote, getNote, getVersion, listNotes, listVersions, patchNote, restoreVersion } from "../services/notes";
import type { Env, AppVariables } from "../types";
import { queueEmptyTrash, queueHardDelete } from "../services/maintenance";

export const noteRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const idOf = (value: string, label = "笔记") => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, "INVALID_ID", `无效的${label} id`);
  return id;
};
const revisionOperationSchema = z.object({ operation_id: z.string().uuid(), expected_revision: z.number().int().positive() });

noteRoutes.get("/", async (c) => {
  const query = c.req.query();
  return c.json(await listNotes(c.env.DB, {
    folderId: query.folder_id ? idOf(query.folder_id, "文件夹") : undefined,
    starred: query.starred === "1",
    deleted: query.deleted === "1",
    q: query.q,
    sortBy: query.sort_by,
    sortDir: query.sort_dir,
    page: query.page ? Number(query.page) : undefined,
    pageSize: query.pageSize ? Number(query.pageSize) : undefined,
  }, c.get("accountSession")));
});

noteRoutes.post("/", async (c) => {
  const parsed = createNoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "新建笔记请求无效");
  return c.json(await createNote(c.env.DB, parsed.data, c.get("accountSession")), 201);
});

noteRoutes.post("/empty-trash", async (c) => {
  const parsed = z.object({ operation_id: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "清空回收站请求无效");
  return c.json(await queueEmptyTrash(c.env.DB, parsed.data.operation_id, c.get("accountSession")), 202);
});

noteRoutes.get("/:id", async (c) => c.json(await getNote(c.env.DB, idOf(c.req.param("id")), c.get("accountSession"))));
noteRoutes.patch("/:id", async (c) => {
  const parsed = patchNoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "保存请求无效");
  return c.json(await patchNote(c.env.DB, idOf(c.req.param("id")), parsed.data, c.get("accountSession")));
});
noteRoutes.delete("/:id", async (c) => {
  const parsed = revisionOperationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "删除请求无效");
  if (c.req.query("hard") === "1") return c.json(await queueHardDelete(c.env.DB, idOf(c.req.param("id")), parsed.data, c.get("accountSession")), 202);
  return c.json(await changeDeletedState(c.env.DB, idOf(c.req.param("id")), parsed.data, false, c.get("accountSession")));
});
noteRoutes.post("/:id/restore", async (c) => {
  const parsed = revisionOperationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "恢复请求无效");
  return c.json(await changeDeletedState(c.env.DB, idOf(c.req.param("id")), parsed.data, true, c.get("accountSession")));
});
noteRoutes.get("/:id/versions", async (c) => c.json(await listVersions(c.env.DB, idOf(c.req.param("id")), Number(c.req.query("page") ?? 1), Number(c.req.query("pageSize") ?? 30), c.get("accountSession"))));
noteRoutes.post("/:id/versions", async (c) => {
  const parsed = z.object({ operation_id: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "创建版本请求无效");
  return c.json(await createManualVersion(c.env.DB, idOf(c.req.param("id")), parsed.data.operation_id, c.get("accountSession")), 201);
});
noteRoutes.get("/:id/versions/:vid", async (c) => c.json(await getVersion(c.env.DB, idOf(c.req.param("id")), idOf(c.req.param("vid"), "版本"), c.get("accountSession"))));
noteRoutes.post("/:id/versions/:vid/restore", async (c) => {
  const parsed = revisionOperationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "恢复版本请求无效");
  return c.json(await restoreVersion(c.env.DB, idOf(c.req.param("id")), idOf(c.req.param("vid"), "版本"), parsed.data, c.get("accountSession")));
});
