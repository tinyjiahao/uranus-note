import { initializeTestAccount, testAccount } from "../accountFixture";
import { beforeAll } from "vitest";
beforeAll(initializeTestAccount);
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../../worker/index";

const origin = "http://uranus.test";

describe("HTTP security boundary", () => {
  it("rejects unauthenticated data and cross-origin login", async () => {
    expect((await app.request(`${origin}/api/notes`, {}, env)).status).toBe(401);
    const response = await app.request(`${origin}/api/session`, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify(testAccount) }, env);
    expect(response.status).toBe(403);
  });

  it("sets a signed cookie, enforces CSRF, and returns JSON 404 for unknown API", async () => {
    const login = await app.request(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(testAccount) }, env);
    expect(login.status).toBe(200);
    const session = await login.json<{ csrfToken: string }>();
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0]!;
    const noCsrf = await app.request(`${origin}/api/folders`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Blocked" }) }, env);
    expect(noCsrf.status).toBe(403);
    const unknown = await app.request(`${origin}/api/does-not-exist`, { headers: { Cookie: cookie } }, env);
    expect(unknown.status).toBe(404);
    expect((await unknown.json<{ error: { code: string } }>()).error.code).toBe("API_NOT_FOUND");
    expect(session.csrfToken.length).toBeGreaterThan(20);
  });

  it("never exposes whole-instance maintenance to the default account", async () => {
    const response = await app.request(origin + "/api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(testAccount) }, env);
    const session = await response.json<{ csrfToken: string }>();
    const headers = { Cookie: response.headers.get("Set-Cookie")!.split(";")[0]!, Origin: origin, "X-CSRF-Token": session.csrfToken };
    for (const path of ["mode", "backup", "restore"]) {
      expect((await app.request(origin + "/api/maintenance/" + path, { headers }, env)).status).toBe(404);
      expect((await app.request(origin + "/api/maintenance/" + path, { method: "POST", headers }, env)).status).toBe(404);
    }
  });
});
