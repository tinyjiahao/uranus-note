import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { version } from "../package.json";
import { emailSchema } from "../shared/account";
import { ApiError, errorJson } from "./lib/http";
import { hmac, timingSafeEqual } from "./lib/crypto";
import { assertOrigin, clearSessionCookie, setSessionCookie } from "./middleware/auth";
import { requestContext } from "./middleware/security";
import { authenticateAccount, changeAccountEmail, changeAccountPassword, registerAccount, renameAccount } from "./services/accounts";
import { issueAccountSession, readAccountSession, revokeAccountSession } from "./services/accountSessions";
import { businessWrite } from "./services/businessWrite";
import { getJob } from "./services/maintenance";
import { folderRoutes } from "./routes/folders";
import { noteRoutes } from "./routes/notes";
import { attachmentRoutes } from "./routes/attachments";
import { importRoutes } from "./routes/import";
import type { AppVariables, Env } from "./types";

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

async function rateLimit(c: AppContext, operation: string, identity?: string) {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const keys = [`${operation}:ip:${await hmac(c.env.SESSION_SECRET, ip)}`];
  if (identity) keys.push(`${operation}:identity:${await hmac(c.env.SESSION_SECRET, identity)}`);
  for (const key of keys) {
    if (!(await c.env.LOGIN_RATE_LIMITER.limit({ key })).success) {
      c.header("Retry-After", "60");
      throw new ApiError(429, "RATE_LIMITED", "操作过于频繁，请稍后重试");
    }
  }
}

// Active v6 entry point. All-site operations remain deployment-only.
export const accountApp = new Hono<{ Bindings: Env; Variables: AppVariables }>();
accountApp.use("*", requestContext);
accountApp.use("/api/*", bodyLimit({ maxSize: 10_500_000, onError: () => { throw new ApiError(413, "REQUEST_TOO_LARGE", "请求过大"); } }));
accountApp.use("/api/*", async (c, next) => {
  if (!c.env.DB || !c.env.UPLOADS || !c.env.LOGIN_RATE_LIMITER || new TextEncoder().encode(c.env.SESSION_SECRET ?? "").length < 32) {
    throw new ApiError(503, "CONFIGURATION_ERROR", "服务配置不完整");
  }
  await next();
});
accountApp.get("/api/health", (c) => c.json({ status: "ok" }));
accountApp.use("/api/*", async (c, next) => {
  if (!await c.env.DB.prepare("SELECT 1 FROM uranus_account_state WHERE id=1 AND ownership_ready=1").first()) {
    throw new ApiError(503, "ACCOUNT_INITIALIZATION_REQUIRED", "账号初始化尚未完成");
  }
  await next();
});
accountApp.get("/api/session", async (c) => {
  const session = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, getCookie(c, "uranus_session"));
  const defaultDataOwner = session ? Boolean(await c.env.DB.prepare("SELECT 1 FROM uranus_account_state WHERE id=1 AND default_user_id=? AND ownership_ready=1").bind(session.user.id).first()) : false;
  return c.json(session
    ? { authenticated: true, user: session.user, defaultDataOwner, csrfToken: session.csrf, expiresAt: session.expiresAt, registrationEnabled: c.env.REGISTRATION_ENABLED === "true" }
    : { authenticated: false, registrationEnabled: c.env.REGISTRATION_ENABLED === "true" });
});
accountApp.post("/api/session", async (c) => {
  assertOrigin(c);
  const body: unknown = await c.req.json().catch(() => null);
  const email = emailSchema.safeParse(body && typeof body === "object" && "email" in body ? body.email : null);
  await rateLimit(c, "login", email.success ? email.data.toLowerCase() : undefined);
  const verified = await authenticateAccount(c.env.DB, body);
  const issued = await issueAccountSession(c.env.DB, c.env.SESSION_SECRET, verified.user.id, verified.credentialVersion, c.env.SESSION_TTL_SECONDS);
  setSessionCookie(c, issued.token, issued.ttl);
  return c.json({ authenticated: true, user: verified.user, csrfToken: issued.csrf, expiresAt: issued.expiresAt });
});
accountApp.post("/api/register", async (c) => {
  assertOrigin(c);
  await rateLimit(c, "register");
  const user = await registerAccount(c.env.DB, c.env.REGISTRATION_ENABLED, await c.req.json().catch(() => null));
  return c.json({ registered: true, email: user.email }, 201);
});
accountApp.use("/api/*", async (c, next) => {
  const session = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, getCookie(c, "uranus_session"));
  if (!session) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  c.set("accountSession", session);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    assertOrigin(c);
    const csrf = c.req.header("X-CSRF-Token");
    if (!csrf || !timingSafeEqual(csrf, session.csrf)) throw new ApiError(403, "CSRF_REJECTED", "CSRF 校验失败");
  }
  await next();
});
accountApp.delete("/api/session", async (c) => {
  await revokeAccountSession(c.env.DB, c.get("accountSession")!);
  clearSessionCookie(c);
  return c.json({ authenticated: false });
});
accountApp.use("/api/*", async (c, next) => {
  if ((await c.env.DB.prepare("SELECT mode FROM uranus_runtime_state WHERE id=1").first<{ mode: string }>())?.mode === "restoring") {
    throw new ApiError(503, "RESTORE_IN_PROGRESS", "恢复期间普通数据接口不可用");
  }
  await next();
});
accountApp.get("/api/account", (c) => c.json(c.get("accountSession")!.user));
accountApp.patch("/api/account", async (c) => {
  const session = c.get("accountSession")!;
  await renameAccount(c.env.DB, session, await c.req.json().catch(() => null));
  const latest = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, getCookie(c, "uranus_session"));
  if (!latest) throw new ApiError(401, "UNAUTHENTICATED", "会话已失效");
  return c.json(latest.user);
});
accountApp.post("/api/account/email", async (c) => {
  const session = c.get("accountSession")!;
  await rateLimit(c, "change-email", session.user.id);
  const result = await changeAccountEmail(c.env.DB, session, await c.req.json().catch(() => null));
  if (result.changed) clearSessionCookie(c);
  return c.json(result);
});
accountApp.post("/api/account/password", async (c) => {
  const session = c.get("accountSession")!;
  await rateLimit(c, "change-password", session.user.id);
  await changeAccountPassword(c.env.DB, session, await c.req.json().catch(() => null));
  clearSessionCookie(c);
  return c.json({ changed: true });
});
accountApp.get("/api/settings/status", (c) => c.json({ version, configured: true }));
accountApp.route("/api/folders", folderRoutes);
accountApp.route("/api/notes", noteRoutes);
accountApp.route("/api/attachments", attachmentRoutes);
accountApp.route("/api/import", importRoutes);
accountApp.get("/api/operations/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT operation_id,scope,status,result_id,result_revision,result_code,created_at FROM uranus_operations WHERE operation_id=? AND user_id=?")
    .bind(c.req.param("id"), c.get("accountSession")!.user.id).first();
  if (!row) throw new ApiError(404, "OPERATION_NOT_FOUND", "操作不存在");
  return c.json(row);
});
accountApp.get("/api/maintenance/jobs/:id", async (c) => c.json(await getJob(c.env.DB, c.req.param("id"), c.get("accountSession"))));
accountApp.post("/api/maintenance/jobs/:id/retry", async (c) => {
  const session = c.get("accountSession")!;
  await getJob(c.env.DB, c.req.param("id"), session);
  await businessWrite(c.env.DB, session, [c.env.DB.prepare("UPDATE uranus_maintenance_jobs SET status='queued',attempt=0,next_attempt_at=?,last_error_code=NULL,updated_at=? WHERE id=? AND user_id=? AND status='failed'")
    .bind(Date.now(), Date.now(), c.req.param("id"), session.user.id)]);
  return c.json(await getJob(c.env.DB, c.req.param("id"), session));
});
// No all-site maintenance/backup/restore routes, including for default admin.
accountApp.all("/api/*", (c) => c.json({ error: { code: "API_NOT_FOUND", message: "API 路径不存在" } }, 404));
accountApp.onError((error, c) => {
  if (error instanceof ApiError) return errorJson(c, error);
  if (error instanceof HTTPException) return error.getResponse();
  console.error(JSON.stringify({ requestId: c.get("requestId"), route: c.req.routePath || "unmatched", errorCode: "INTERNAL_ERROR" }));
  return errorJson(c, new ApiError(500, "INTERNAL_ERROR", "服务器内部错误"));
});
