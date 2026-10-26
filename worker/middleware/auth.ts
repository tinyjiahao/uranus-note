import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { ApiError } from "../lib/http";
import type { Env, AppVariables } from "../types";
const COOKIE = "uranus_session";
export function expectedOrigin(c: Context<{ Bindings: Env; Variables: AppVariables }>): string {
  return c.env.APP_ENV === "development" ? new URL(c.req.url).origin : c.env.APP_ORIGIN ?? new URL(c.req.url).origin;
}

export function assertOrigin(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const origin = c.req.header("Origin");
  if (!origin || origin !== expectedOrigin(c)) throw new ApiError(403, "ORIGIN_REJECTED", "请求来源不受信任");
}

export function setSessionCookie(c: Context<{ Bindings: Env; Variables: AppVariables }>, token: string, ttl: number) {
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: c.env.APP_ENV !== "development", sameSite: "Strict", path: "/",
    maxAge: ttl, expires: new Date(Date.now() + ttl * 1000),
  });
}

export function clearSessionCookie(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  deleteCookie(c, COOKIE, { secure: c.env.APP_ENV !== "development", sameSite: "Strict", path: "/" });
}
