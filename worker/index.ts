import { Hono } from "hono";
import { version as appVersion } from "../package.json";
import { HTTPException } from "hono/http-exception";
import { ApiError, errorJson } from "./lib/http";
import { requireAuth, requireWriteProtection } from "./middleware/auth";
import { requestContext } from "./middleware/security";
import { folderRoutes } from "./routes/folders";
import { attachmentRoutes } from "./routes/attachments";
import { noteRoutes } from "./routes/notes";
import { sessionRoutes } from "./routes/session";
import { maintenanceRoutes } from "./routes/maintenance";
import { discoverExpiredTrash, processMaintenance } from "./services/maintenance";
import { importRoutes } from "./routes/import";
import type { Env, AppVariables } from "./types";

export const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
app.use("*", requestContext);

app.get("/api/health", (c) => {
  const configured = Boolean(c.env.DB && c.env.UPLOADS && c.env.LOGIN_RATE_LIMITER && c.env.API_TOKEN && c.env.SESSION_SECRET);
  return c.json({ status: configured ? "ok" : "unavailable" }, configured ? 200 : 503);
});
app.route("/api/session", sessionRoutes);

app.use("/api/*", requireAuth);
app.get("/api/settings/status", async (c) => {
  let database = "检查失败";
  try { await c.env.DB.prepare("SELECT id FROM uranus_runtime_state WHERE id=1").first(); database = "读取正常（未探测写入）"; } catch { /* Never expose raw binding errors. */ }
  return c.json({ version: appVersion, configured: Boolean(c.env.DB && c.env.UPLOADS && c.env.LOGIN_RATE_LIMITER && c.env.API_TOKEN && c.env.SESSION_SECRET), database, attachments: "已绑定（未探测读写）" });
});
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/maintenance/")) return next();
  const state = await c.env.DB.prepare("SELECT mode FROM uranus_runtime_state WHERE id=1").first<{ mode: string }>();
  if (state?.mode === "restoring") throw new ApiError(503, "RESTORE_IN_PROGRESS", "恢复期间普通数据接口不可用");
  return next();
});
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return requireWriteProtection(c, next);
  return next();
});
app.route("/api/folders", folderRoutes);
app.route("/api/notes", noteRoutes);
app.route("/api/attachments", attachmentRoutes);
app.route("/api/maintenance", maintenanceRoutes);
app.route("/api/import", importRoutes);

app.get("/api/operations/:id", async (c) => {
  const operation = await c.env.DB.prepare("SELECT operation_id, scope, status, result_id, result_revision, result_code, created_at FROM uranus_operations WHERE operation_id=?").bind(c.req.param("id")).first();
  if (!operation) throw new ApiError(404, "OPERATION_NOT_FOUND", "操作不存在");
  return c.json(operation);
});

app.all("/api/*", (c) => c.json({ error: { code: "API_NOT_FOUND", message: "API 路径不存在", requestId: c.get("requestId") } }, 404));

app.onError((error, c) => {
  if (error instanceof ApiError) return errorJson(c, error);
  if (error instanceof HTTPException) return error.getResponse();
  console.error(JSON.stringify({ requestId: c.get("requestId"), route: c.req.routePath || "unmatched", status: 500, errorCode: "INTERNAL_ERROR" }));
  return errorJson(c, new ApiError(500, "INTERNAL_ERROR", "服务器内部错误"));
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      if (controller.cron === "0 3 * * *") await discoverExpiredTrash(env.DB);
      await processMaintenance(env.DB, env.UPLOADS);
      await env.DB.prepare("DELETE FROM uranus_operations WHERE status <> 'pending' AND expires_at < ?").bind(Date.now()).run();
    })());
  },
} satisfies ExportedHandler<Env>;
