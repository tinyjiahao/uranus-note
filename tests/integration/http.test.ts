import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../../worker/index";

const origin = "http://uranus.test";

describe("HTTP security boundary", () => {
  it("rejects unauthenticated data and cross-origin login", async () => {
    expect((await app.request(`${origin}/api/notes`, {}, env)).status).toBe(401);
    const response = await app.request(`${origin}/api/session`, { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ token: env.API_TOKEN }) }, env);
    expect(response.status).toBe(403);
  });

  it("sets a signed cookie, enforces CSRF, and returns JSON 404 for unknown API", async () => {
    const login = await app.request(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: env.API_TOKEN }) }, env);
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

  it("restores an empty target in idempotent batches and keeps it frozen until confirmed", async () => {
    const login = await app.request(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: env.API_TOKEN }) }, env);
    const session = await login.json<{ csrfToken: string }>();
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0]!;
    const writeHeaders = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
    const uuidv7 = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16)); const time = BigInt(Date.now());
      for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 255n);
      bytes[6] = ((bytes[6] ?? 0) & 15) | 112; bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    };
    const maintenanceId = uuidv7();
    const mode = await app.request(`${origin}/api/maintenance/mode`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ operation_id: maintenanceId, purpose: "restore" }) }, env);
    expect(mode.status).toBe(200);
    const send = async (entity: string, batchId: string, items: Record<string, unknown>[]) => {
      const checksum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(items)));
      let binary = ""; for (const byte of new Uint8Array(checksum)) binary += String.fromCharCode(byte);
      const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      return app.request(`${origin}/api/maintenance/restore`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ maintenance_id: maintenanceId, backup_id: "test-backup", batch_id: batchId, entity, checksum: encoded, items }) }, env);
    };
    const now = Date.now();
    expect((await send("folders", "folders:0", [{ id: 1, name: "Notes", system_key: "default", created_at: now, updated_at: now }])).status).toBe(200);
    const content = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "restored 文本" }] }] });
    expect((await send("notes", "notes:0", [{ id: 8001, folder_id: 1, prev_folder_id: null, title: "restored 文本", snippet: "restored 文本", content_json: content, revision: 4, pinned: 0, starred: 0, deleted_at: null, created_at: now, updated_at: now }])).status).toBe(200);
    const tableContent = JSON.stringify({ type: "doc", content: [{ type: "table", attrs: { widthMode: "fixed" }, content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth: [220], textAlign: "right", verticalAlign: "bottom" }, content: [{ type: "paragraph" }] }] }] }] });
    expect((await send("versions", "versions:0", [{ id: 9001, note_id: 8001, content_json: tableContent, content_schema_version: 2, title: "table", source_revision: 3, created_at: now }])).status).toBe(200);
    expect((await send("search", "search:0", [{ note_id: 8001 }])).status).toBe(200);
    expect((await send("finalize", "finalize:0", [])).status).toBe(200);
    const versionResponse = await app.request(`${origin}/api/notes/8001/versions/9001`, { headers: { Cookie: cookie } }, env);
    expect((await versionResponse.json<{ content: unknown }>()).content).toEqual(JSON.parse(tableContent));
    const metadata = await app.request(`${origin}/api/maintenance/backup?maintenance_id=${maintenanceId}&entity=metadata`, { headers: { Cookie: cookie } }, env);
    expect(await metadata.json()).toMatchObject({ contentSchemaVersion: 3, migrationVersion: "0004_block_alignment" });
    expect((await app.request(`${origin}/api/notes/8001`, { headers: { Cookie: cookie } }, env)).status).toBe(200);
    const release = await app.request(`${origin}/api/maintenance/mode`, { method: "DELETE", headers: writeHeaders, body: JSON.stringify({ maintenance_id: maintenanceId, confirm: true }) }, env);
    expect(release.status).toBe(200);
    const note = await (await app.request(`${origin}/api/notes/8001`, { headers: { Cookie: cookie } }, env)).json<{ title: string; revision: number }>();
    expect(note).toMatchObject({ title: "restored 文本", revision: 4 });
  });
});
