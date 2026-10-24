import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/http";
import { hmac } from "../lib/crypto";
import { assertOrigin, clearSessionCookie, createSession, requireAuth, requireWriteProtection, setSessionCookie, verifyLoginToken, verifySession } from "../middleware/auth";
import type { Env, AppVariables } from "../types";
import { getCookie } from "hono/cookie";

export const sessionRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const loginSchema = z.object({ token: z.string().min(1).max(4096) });

sessionRoutes.get("/", async (c) => {
  const session = await verifySession(c.env, getCookie(c, "uranus_session"));
  return c.json(session ? { authenticated: true, csrfToken: session.csrf, expiresAt: session.exp * 1000 } : { authenticated: false });
});

sessionRoutes.post("/", async (c) => {
  assertOrigin(c);
  if (!c.env.DB || !c.env.UPLOADS || !c.env.LOGIN_RATE_LIMITER || !c.env.API_TOKEN || !c.env.SESSION_SECRET) throw new ApiError(503, "CONFIGURATION_ERROR", "服务配置不完整");
  const source = c.req.header("CF-Connecting-IP") ?? (c.env.APP_ENV === "development" ? "local-development" : "missing");
  const key = await hmac(c.env.SESSION_SECRET, `login:${source}`);
  let limited: { success: boolean };
  try { limited = await c.env.LOGIN_RATE_LIMITER.limit({ key }); }
  catch { throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "登录服务暂不可用"); }
  if (!limited.success) {
    c.header("Retry-After", "60");
    throw new ApiError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后再试");
  }
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !(await verifyLoginToken(c.env, parsed.data.token))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "访问令牌无效");
  }
  const { token, payload, ttl } = await createSession(c.env);
  setSessionCookie(c, token, ttl);
  return c.json({ authenticated: true, csrfToken: payload.csrf, expiresAt: payload.exp * 1000 });
});

sessionRoutes.delete("/", requireAuth, requireWriteProtection, (c) => {
  clearSessionCookie(c);
  return c.json({ authenticated: false });
});
