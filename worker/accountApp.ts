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
import { MAX_REMEMBERED_ACCOUNTS, rememberedAccounts, writeRememberedAccounts } from "./services/rememberedAccounts";
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
  const current = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, getCookie(c, "uranus_session"));
  if (current && !timingSafeEqual(c.req.header("X-CSRF-Token") ?? "", current.csrf)) throw new ApiError(403, "CSRF_REJECTED", "请刷新页面后登录其他账号");
  const body: unknown = await c.req.json().catch(() => null);
  const email = emailSchema.safeParse(body && typeof body === "object" && "email" in body ? body.email : null);
  await rateLimit(c, "login", email.success ? email.data.toLowerCase() : undefined);
  const verified = await authenticateAccount(c.env.DB, body);
  const remembered = await rememberedAccounts(c);
  const otherAccounts = remembered.filter(entry => entry.session.user.id !== verified.user.id);
  if (otherAccounts.length >= MAX_REMEMBERED_ACCOUNTS) throw new ApiError(409, "ACCOUNT_LIMIT", "本浏览器最多记住 5 个账号，请先移除一个账号");
  const issued = await issueAccountSession(c.env.DB, c.env.SESSION_SECRET, verified.user.id, verified.credentialVersion, c.env.SESSION_TTL_SECONDS);
  // Re-authentication replaces this browser's previous credential for this user.
  for (const entry of remembered.filter(entry => entry.session.user.id === verified.user.id)) await revokeAccountSession(c.env.DB, entry.session);
  setSessionCookie(c, issued.token, issued.ttl);
  writeRememberedAccounts(c, [...otherAccounts, { token: issued.token, session: { expiresAt: issued.expiresAt } }]);
  return c.json({ authenticated: true, user: verified.user, csrfToken: issued.csrf, expiresAt: issued.expiresAt });
});
accountApp.post("/api/register", async (c) => {
  assertOrigin(c);
  await rateLimit(c, "register");
  const user = await registerAccount(c.env.DB, c.env.REGISTRATION_ENABLED, await c.req.json().catch(() => null));
  return c.json({ registered: true, email: user.email }, 201);
});
// A valid remembered credential remains usable when the active account expires.
// This token is scoped to the current cookie set, not a business-session CSRF.
const switchToken = (c: AppContext, entries: Awaited<ReturnType<typeof rememberedAccounts>>) => hmac(c.env.SESSION_SECRET, "account-switch:" + entries.map(entry => entry.session.credentialDigest).sort().join(":"));
accountApp.get("/api/account/sessions", async (c) => {
  const entries = await rememberedAccounts(c);
  const active = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, getCookie(c, "uranus_session"));
  return c.json({ accounts: entries.map(({ session }) => ({ user: session.user, expiresAt: session.expiresAt, current: session.user.id === active?.user.id })), limit: MAX_REMEMBERED_ACCOUNTS, switchToken: entries.length ? await switchToken(c, entries) : "" });
});
accountApp.post("/api/account/switch", async (c) => {
  assertOrigin(c);
  await rateLimit(c, "account-switch");
  const entries = await rememberedAccounts(c);
  const csrf = c.req.header("X-Account-Switch-Token");
  if (!entries.length || !csrf || !timingSafeEqual(csrf, await switchToken(c, entries))) throw new ApiError(403, "CSRF_REJECTED", "账号列表已变化，请重新打开切换账号菜单");
  const body = await c.req.json<{ userId?: unknown }>().catch(() => ({} as { userId?: unknown }));
  const target = entries.find(entry => entry.session.user.id === body.userId);
  if (!target) throw new ApiError(404, "ACCOUNT_NOT_REMEMBERED", "此账号登录已过期或未在本浏览器登录，请输入密码重新登录");
  const session = await readAccountSession(c.env.DB, c.env.SESSION_SECRET, target.token);
  if (!session) throw new ApiError(409, "SESSION_EXPIRED", "目标账号登录已失效，请重新登录");
  setSessionCookie(c, target.token, Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)));
  writeRememberedAccounts(c, entries);
  return c.json({ authenticated: true, user: session.user, csrfToken: session.csrf, expiresAt: session.expiresAt });
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
  const entries = await rememberedAccounts(c);
  await c.env.DB.batch(entries.map(({ session }) => c.env.DB.prepare("UPDATE uranus_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE credential_digest=? AND user_id=?").bind(Date.now(), session.credentialDigest, session.user.id)));
  writeRememberedAccounts(c, []);
  clearSessionCookie(c);
  return c.json({ authenticated: false });
});
accountApp.post("/api/account/forget", async (c) => {
  const body = await c.req.json<{ userId?: unknown }>().catch(() => ({} as { userId?: unknown }));
  if (body.userId === c.get("accountSession")!.user.id) throw new ApiError(400, "CURRENT_ACCOUNT", "不能移除当前账号，请先切换或退出");
  const entries = await rememberedAccounts(c);
  const target = entries.find(entry => entry.session.user.id === body.userId);
  if (target) await revokeAccountSession(c.env.DB, target.session);
  writeRememberedAccounts(c, entries.filter(entry => entry !== target));
  return c.json({ removed: true });
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
