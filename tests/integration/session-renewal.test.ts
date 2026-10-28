import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { initializeTestAccount, testAccount } from "../accountFixture";
import { accountApp } from "../../worker/accountApp";
import { issueAccountSession, readAccountSession } from "../../worker/services/accountSessions";

it("renews only active valid sessions, throttles writes, and protects the endpoint", async () => {
  await initializeTestAccount();
  const bindings = { ...env, LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const call = (path: string, method = "GET", cookie = "", csrf = "", body?: unknown) => accountApp.request(`http://uranus.test${path}`, {
    method, headers: { Origin: "http://uranus.test", Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, bindings);
  const login = await call("/api/session", "POST", "", "", testAccount);
  expect(login.status).toBe(200);
  const { csrfToken } = await login.json<{ csrfToken: string }>();
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const session = (await readAccountSession(env.DB, env.SESSION_SECRET, token))!;
  const other = await issueAccountSession(env.DB, env.SESSION_SECRET, session.user.id, session.credentialVersion);
  const oldExpiry = Date.now() + 22 * 3600_000;
  await env.DB.prepare("UPDATE uranus_sessions SET expires_at=? WHERE credential_digest=?").bind(oldExpiry, session.credentialDigest).run();
  await call("/api/session", "GET", cookie);
  expect((await readAccountSession(env.DB, env.SESSION_SECRET, token))!.expiresAt).toBe(oldExpiry);
  expect((await call("/api/session/activity", "POST", cookie)).status).toBe(403);
  const response = await call("/api/session/activity", "POST", cookie, csrfToken);
  expect(response.status).toBe(200);
  const renewed = await response.json<{ expiresAt: number }>();
  expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 23.9 * 3600_000);
  expect(response.headers.get("set-cookie")).toContain("uranus_accounts=");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect((await readAccountSession(env.DB, env.SESSION_SECRET, other.token))!.expiresAt).toBe(other.expiresAt);
  const parallel = await Promise.all(Array.from({ length: 3 }, () => call("/api/session/activity", "POST", cookie, csrfToken)));
  for (const result of parallel) expect((await result.json<{ expiresAt: number }>()).expiresAt).toBe(renewed.expiresAt);
  await env.DB.prepare("UPDATE uranus_sessions SET revoked_at=? WHERE credential_digest=?").bind(Date.now(), session.credentialDigest).run();
  expect((await call("/api/session/activity", "POST", cookie, csrfToken)).status).toBe(401);
  await env.DB.prepare("UPDATE uranus_sessions SET revoked_at=NULL,expires_at=? WHERE credential_digest=?").bind(Date.now() - 1, session.credentialDigest).run();
  expect((await call("/api/session/activity", "POST", cookie, csrfToken)).status).toBe(401);
  await env.DB.prepare("UPDATE uranus_sessions SET expires_at=?,credential_version=credential_version+1 WHERE credential_digest=?").bind(Date.now() + 3600_000, session.credentialDigest).run();
  expect((await call("/api/session/activity", "POST", cookie, csrfToken)).status).toBe(401);
});
