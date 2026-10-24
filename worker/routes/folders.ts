import { Hono } from "hono";
import { folderSchema } from "../../shared/validation";
import { ApiError } from "../lib/http";
import { createFolder, deleteFolder, listFolders, renameFolder } from "../services/folders";
import type { Env, AppVariables } from "../types";

export const folderRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const idOf = (value: string) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, "INVALID_ID", "无效的文件夹 id");
  return id;
};

folderRoutes.get("/", async (c) => c.json(await listFolders(c.env.DB)));
folderRoutes.post("/", async (c) => {
  const parsed = folderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "文件夹名称无效");
  return c.json(await createFolder(c.env.DB, parsed.data.name), 201);
});
folderRoutes.patch("/:id", async (c) => {
  const parsed = folderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "文件夹名称无效");
  return c.json(await renameFolder(c.env.DB, idOf(c.req.param("id")), parsed.data.name));
});
folderRoutes.delete("/:id", async (c) => c.json(await deleteFolder(c.env.DB, idOf(c.req.param("id")))));
