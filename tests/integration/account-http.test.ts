import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { accountApp } from "../../worker/accountApp";
import { initializeDefaultAccount } from "../../worker/services/initializeAccount";
import { uuidv7 } from "../../src/api/client";

const origin = "http://uranus.test", password = "test-http-password";
const bindings = { ...env, API_TOKEN: "", REGISTRATION_ENABLED: "true", LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) } };
type Headers = Record<string, string>;
let a: Headers, b: Headers;
const request = (path: string, method = "GET", headers: Headers = {}, body?: unknown) => accountApp.request(origin + path, {
  method, headers: { Origin: origin, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, bindings);
async function login(email: string) {
  const response = await request("/api/session", "POST", {}, { email, password });
  expect(response.status).toBe(200);
  const data = await response.json<{ csrfToken: string }>();
  return { Cookie: response.headers.get("Set-Cookie")!.split(";")[0]!, "X-CSRF-Token": data.csrfToken };
}
beforeAll(async () => {
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id='test-http' WHERE id=1").run();
  await initializeDefaultAccount(env.DB, { email: "admin@example.com", password, maintenanceId: "test-http" });
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL WHERE id=1").run();
  expect((await request("/api/register", "POST", {}, { email: "other@example.com", username: "Other", password, confirmPassword: password })).status).toBe(201);
  a = await login("admin@example.com"); b = await login("other@example.com");
});

it("runs email login without API_TOKEN, rejects old token payloads, and omits all-site operations", async () => {
  expect((await request("/api/session", "POST", {}, { token: "legacy-token" })).status).toBe(400);
  expect((await request("/api/notes")).status).toBe(401);
  const current = await request("/api/session", "GET", a);
  expect((await current.json<{ authenticated: boolean }>()).authenticated).toBe(true);
  for (const path of ["/api/maintenance/mode", "/api/maintenance/backup", "/api/maintenance/restore"]) {
    expect((await request(path, "GET", a)).status).toBe(404);
    expect((await request(path, "POST", a, {})).status).toBe(404);
  }
});

it("isolates actual HTTP notes, lists, search, versions and idempotency receipts", async () => {
  const op = uuidv7();
  const created = await request("/api/notes", "POST", b, { operation_id: op, content_schema_version: 5,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "private-http-search" }] }] } });
  expect(created.status).toBe(201);
  const note = await created.json<{ id: number; folderId: number }>();
  for (const path of [`/api/notes/${note.id}`, `/api/notes/${note.id}/versions`, `/api/operations/${op}`, `/api/notes?folder_id=${note.folderId}`]) {
    expect((await request(path, "GET", a)).status).toBe(404);
  }
  expect((await (await request("/api/notes?q=private-http-search", "GET", a)).json<{ totalCount: number }>()).totalCount).toBe(0);
  expect((await (await request("/api/notes?q=private-http-search", "GET", b)).json<{ totalCount: number }>()).totalCount).toBe(1);
  expect((await request(`/api/notes/${note.id}`, "PATCH", a, { operation_id: uuidv7(), expected_revision: 1, content_schema_version: 5, starred: true })).status).toBe(404);
  expect((await request("/api/notes", "POST", a, { operation_id: op, content_schema_version: 5 })).status).toBe(404);
  const job = await (await request("/api/notes/empty-trash", "POST", b, { operation_id: uuidv7() })).json<{ job_id: string }>();
  expect((await request(`/api/maintenance/jobs/${job.job_id}`, "GET", a)).status).toBe(404);
  expect((await request(`/api/maintenance/jobs/${job.job_id}/retry`, "POST", a, {})).status).toBe(404);
});

it("checks CSRF and actually revokes the current session on logout", async () => {
  const separate = await login("admin@example.com");
  expect((await request("/api/session", "DELETE", { Cookie: separate.Cookie! })).status).toBe(403);
  expect((await request("/api/session", "DELETE", separate)).status).toBe(200);
  expect((await request("/api/notes", "GET", separate)).status).toBe(401);
  expect((await request("/api/notes", "GET", a)).status).toBe(200);
});

it("checks origin and HMAC-based rate-limit keys without exposing email in keys", async () => {
  expect((await request("/api/session", "POST", { Origin: "https://foreign.test" }, { email: "admin@example.com", password })).status).toBe(403);
  const keys: string[] = [];
  const response = await accountApp.request(origin + "/api/session", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password }),
  }, { ...bindings, LOGIN_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.length < 2 }; } } });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(keys).toHaveLength(2);
  expect(keys.join(" ")).not.toContain("admin@example.com");
});
