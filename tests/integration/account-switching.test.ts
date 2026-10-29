import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { accountApp } from "../../worker/accountApp";
import { initializeDefaultAccount } from "../../worker/services/initializeAccount";

const origin = "http://uranus.test", password = "switch-test-password";
const bindings = { ...env, REGISTRATION_ENABLED: "true", SESSION_TTL_SECONDS: "604800", LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) } };
type Session = { user: { id: string; email: string }; csrfToken: string; expiresAt: number };
type Accounts = { accounts: { user: { id: string }; expiresAt: number; current: boolean }[]; switchToken: string };
function browser() {
  const cookies = new Map<string, string>();
  let csrf = "";
  return {
    cookies,
    async request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
      const response = await accountApp.request(origin + path, {
        method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; "), "X-CSRF-Token": csrf, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, bindings);
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!; const split = pair.indexOf("=");
        const name = pair.slice(0, split), value = pair.slice(split + 1);
        if (value) cookies.set(name, value); else cookies.delete(name);
      }
      const data = await response.clone().json() as Partial<Session>;
      if (data.csrfToken) csrf = data.csrfToken;
      return response;
    },
  };
}
beforeAll(async () => {
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id='switch-test' WHERE id=1").run();
  await initializeDefaultAccount(env.DB, { email: "admin@example.com", password, maintenanceId: "switch-test" });
  await env.DB.prepare("UPDATE uranus_runtime_state SET mode='normal',maintenance_id=NULL WHERE id=1").run();
  for (let i = 1; i <= 5; i++) expect((await browser().request("/api/register", "POST", { email: `switch${i}@example.com`, username: `switch${i}`, password, confirmPassword: password })).status).toBe(201);
});

it("remembers signed sessions, switches without renewing, and logs out all remembered accounts", async () => {
  const client = browser();
  const response = await client.request("/api/session", "POST", { email: "admin@example.com", password });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie().every(value => value.includes("HttpOnly") && value.includes("SameSite=Strict") && value.includes("Max-Age="))).toBe(true);
  const a = await response.json<Session>(); const tokenA = client.cookies.get("uranus_session")!;
  const b = await (await client.request("/api/session", "POST", { email: "switch1@example.com", password })).json<Session>();
  const tokenB = client.cookies.get("uranus_session")!;
  const list = await (await client.request("/api/account/sessions")).json<Accounts>();
  expect(list.accounts).toHaveLength(2);
  expect(JSON.stringify(list)).not.toContain(tokenA);
  expect(a.expiresAt - Date.now()).toBeGreaterThan(600_000_000);
  expect((await client.request("/api/account/switch", "POST", { userId: a.user.id })).status).toBe(403);
  expect((await client.request("/api/account/switch", "POST", { userId: "foreign" }, { "X-Account-Switch-Token": list.switchToken })).status).toBe(404);
  expect((await client.request("/api/account/switch", "POST", { userId: a.user.id }, { Origin: "https://foreign.test", "X-Account-Switch-Token": list.switchToken })).status).toBe(403);
  const switched = await (await client.request("/api/account/switch", "POST", { userId: a.user.id }, { "X-Account-Switch-Token": list.switchToken })).json<Session>();
  expect(switched.user.id).toBe(a.user.id); expect(switched.expiresAt).toBe(a.expiresAt);
  expect(client.cookies.get("uranus_session")).toBe(tokenA);
  expect((await client.request("/api/session", "DELETE")).status).toBe(200);
  expect(client.cookies.size).toBe(0);
  for (const token of [tokenA, tokenB]) {
    const stale = browser(); stale.cookies.set("uranus_session", token);
    expect((await stale.request("/api/notes")).status).toBe(401);
  }
  expect(b.user.id).not.toBe(a.user.id);
});

it("handles expiry, removal, tampering and the five-account bound", async () => {
  const client = browser();
  const a = await (await client.request("/api/session", "POST", { email: "admin@example.com", password })).json<Session>();
  const b = await (await client.request("/api/session", "POST", { email: "switch1@example.com", password })).json<Session>();
  await env.DB.prepare("UPDATE uranus_sessions SET expires_at=? WHERE user_id=?").bind(Date.now() - 1, b.user.id).run();
  const valid = await (await client.request("/api/account/sessions")).json<Accounts>();
  expect(valid.accounts.map(entry => entry.user.id)).toEqual([a.user.id]);
  expect((await client.request("/api/account/switch", "POST", { userId: a.user.id }, { "X-Account-Switch-Token": valid.switchToken })).status).toBe(200);
  for (let i = 1; i <= 4; i++) expect((await client.request("/api/session", "POST", { email: `switch${i}@example.com`, password })).status).toBe(200);
  expect((await client.request("/api/session", "POST", { email: "switch5@example.com", password })).status).toBe(409);
  expect((await client.request("/api/account/forget", "POST", { userId: a.user.id })).status).toBe(200);
  const after = await (await client.request("/api/account/sessions")).json<Accounts>();
  expect(after.accounts).toHaveLength(4);
  expect((await client.request("/api/account/switch", "POST", { userId: a.user.id }, { "X-Account-Switch-Token": after.switchToken })).status).toBe(404);
  const changed = after.accounts.find(entry => !entry.current)!;
  await env.DB.prepare("UPDATE uranus_users SET credential_version=credential_version+1 WHERE id=?").bind(changed.user.id).run();
  const renewedList = await (await client.request("/api/account/sessions")).json<Accounts>();
  expect(renewedList.accounts.some(entry => entry.user.id === changed.user.id)).toBe(false);
  expect((await client.request("/api/account/switch", "POST", { userId: changed.user.id }, { "X-Account-Switch-Token": renewedList.switchToken })).status).toBe(404);
  const outsider = browser(); outsider.cookies.set("uranus_accounts", "tampered");
  expect((await (await outsider.request("/api/account/sessions")).json<Accounts>()).accounts).toEqual([]);
  expect((await outsider.request("/api/account/switch", "POST", { userId: a.user.id }, { "X-Account-Switch-Token": after.switchToken })).status).toBe(403);
});
