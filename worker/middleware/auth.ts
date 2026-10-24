import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { ApiError } from "../lib/http";
import { fromBase64url, hmac, sha256, timingSafeEqual, base64url } from "../lib/crypto";
import type { Env, AppVariables, SessionPayload } from "../types";

const COOKIE = "uranus_session";
const encoder = new TextEncoder();

function assertConfig(env: Partial<Env>) {
  if (!env.DB || !env.UPLOADS || !env.LOGIN_RATE_LIMITER || !env.API_TOKEN || !env.SESSION_SECRET) {
    throw new ApiError(503, "CONFIGURATION_ERROR", "服务配置不完整");
  }
  if (encoder.encode(env.API_TOKEN).byteLength < 32 || encoder.encode(env.SESSION_SECRET).byteLength < 32) {
    throw new ApiError(503, "CONFIGURATION_ERROR", "服务密钥长度不足");
  }
}

export async function tokenFingerprint(env: Env): Promise<string> {
  return hmac(env.SESSION_SECRET, `token:${env.API_TOKEN}`);
}

export async function createSession(env: Env): Promise<{ token: string; payload: SessionPayload; ttl: number }> {
  assertConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const parsedTtl = Number.parseInt(env.SESSION_TTL_SECONDS ?? "86400", 10);
  const ttl = Number.isFinite(parsedTtl) ? Math.min(Math.max(parsedTtl, 60), 2_592_000) : 86_400;
  const payload: SessionPayload = {
    sid: crypto.randomUUID(), iat: now, exp: now + ttl,
    tokenFingerprint: await tokenFingerprint(env),
    csrf: base64url(crypto.getRandomValues(new Uint8Array(24))),
  };
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  return { token: `${encoded}.${await hmac(env.SESSION_SECRET, encoded)}`, payload, ttl };
}

export async function verifySession(env: Env, token?: string): Promise<SessionPayload | null> {
  assertConfig(env);
  if (!token) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  if (!timingSafeEqual(signature, await hmac(env.SESSION_SECRET, encoded))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(encoded))) as SessionPayload;
    if (!payload.sid || !payload.csrf || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!timingSafeEqual(payload.tokenFingerprint, await tokenFingerprint(env))) return null;
    return payload;
  } catch {
    return null;
  }
}

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const session = await verifySession(c.env, getCookie(c, COOKIE));
  if (!session) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  c.set("session", session);
  await next();
});

export function expectedOrigin(c: Context<{ Bindings: Env; Variables: AppVariables }>): string {
  return c.env.APP_ENV === "development" ? new URL(c.req.url).origin : c.env.APP_ORIGIN ?? new URL(c.req.url).origin;
}

export function assertOrigin(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const origin = c.req.header("Origin");
  if (!origin || origin !== expectedOrigin(c)) throw new ApiError(403, "ORIGIN_REJECTED", "请求来源不受信任");
}

export const requireWriteProtection = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  assertOrigin(c);
  const provided = c.req.header("X-CSRF-Token");
  if (!provided || !timingSafeEqual(provided, c.get("session").csrf)) throw new ApiError(403, "CSRF_REJECTED", "CSRF 校验失败");
  await next();
});

export function setSessionCookie(c: Context<{ Bindings: Env; Variables: AppVariables }>, token: string, ttl: number) {
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: c.env.APP_ENV !== "development", sameSite: "Strict", path: "/",
    maxAge: ttl, expires: new Date(Date.now() + ttl * 1000),
  });
}

export function clearSessionCookie(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  deleteCookie(c, COOKIE, { secure: c.env.APP_ENV !== "development", sameSite: "Strict", path: "/" });
}

export async function verifyLoginToken(env: Env, candidate: string): Promise<boolean> {
  assertConfig(env);
  return timingSafeEqual(await sha256(candidate), await sha256(env.API_TOKEN));
}
