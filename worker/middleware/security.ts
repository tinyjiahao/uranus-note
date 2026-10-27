import { createMiddleware } from "hono/factory";
import type { Env, AppVariables } from "../types";

export const requestContext = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("X-Frame-Options", "DENY");
  if (new URL(c.req.url).protocol === "https:" && c.env.APP_ENV === "production") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const privateAttachment = c.req.method === "GET" && /^\/api\/attachments\/[^/]+$/.test(c.req.path)
    && [200, 304].includes(c.res.status) && c.res.headers.get("Cache-Control") === "private, max-age=31536000, immutable";
  if (c.req.path.startsWith("/api/") && !privateAttachment) c.header("Cache-Control", "no-store");
});
