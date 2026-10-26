// Read-only business verification against the configured deployment. Creates
// and revokes only its own login session. Never prints credentials or content.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { unstable_readConfig } from "wrangler";
import { verify } from "./local-operations.mjs";

let cookie, csrf, origin;
const request = (path, options = {}) => fetch(origin + path, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers }, signal: AbortSignal.timeout(30_000) });
try {
  const config = unstable_readConfig({ config: "wrangler.jsonc" });
  origin = config.vars.APP_ORIGIN;
  assert.equal(new URL(origin).protocol, "https:");
  const vars = parseEnv(await readFile(".env.production.local", "utf8"));
  const { files } = await verify(process.argv[2]);
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/api/notes")).status, 401);
  const anonymous = await (await request("/api/session")).json();
  assert.equal(anonymous.authenticated, false);
  assert.equal(anonymous.registrationEnabled, false);
  const login = await request("/api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: process.argv[3] || "admin@admin.com", password: vars.ADMIN_INITIAL_PASSWORD }) });
  assert.equal(login.status, 200);
  const info = await login.json(), header = login.headers.get("set-cookie");
  assert.match(header, /HttpOnly/i); assert.match(header, /Secure/i); assert.match(header, /SameSite=Strict/i); assert.doesNotMatch(header, /Domain=/i);
  cookie = header.split(";")[0]; csrf = info.csrfToken;
  assert.equal((await (await request("/api/session")).json()).authenticated, true);
  assert.equal((await request("/api/maintenance/backup")).status, 404);
  assert.equal((await request("/api/account", { method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  let notes = 0, attachments = 0, versions = 0;
  for (const file of files.filter(f => f.table === "uranus_notes")) for (const row of JSON.parse(file.bytes)) {
    const response = await request(`/api/notes/${row.id}`); assert.equal(response.status, 200);
    const note = await response.json();
    assert.equal(note.revision, row.revision);
    assert.deepEqual(note.content, JSON.parse(row.content_json));
    notes++;
  }
  for (const file of files.filter(f => f.table === "uranus_note_versions")) for (const row of JSON.parse(file.bytes)) {
    const response = await request(`/api/notes/${row.note_id}/versions/${row.id}`); assert.equal(response.status, 200);
    const version = await response.json(); assert.deepEqual(version.content, JSON.parse(row.content_json)); versions++;
  }
  for (const file of files.filter(f => f.table === "uranus_attachments")) for (const row of JSON.parse(file.bytes).filter(r => r.status === "ready")) {
    const response = await request(`/api/attachments/${row.id}`); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, row.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), files.find(f => f.objectKey === row.object_key).plainSha256);
    attachments++;
  }
  const legacy = await request("/api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: vars.URANUS_API_TOKEN || "obsolete-token" }) });
  assert.equal(legacy.status, 400);
  const logout = await request("/api/session", { method: "DELETE", headers: { Origin: origin, "X-CSRF-Token": csrf } });
  assert.equal(logout.status, 200); assert.equal((await request("/api/notes")).status, 401);
  cookie = undefined;
  console.log(JSON.stringify({ passed: true, notesUnchanged: notes, versionsUnchanged: versions, attachmentChecksumsMatched: attachments, legacyTokenRejected: true, sessionRevoked: true }));
} catch { console.error("PRODUCTION_VERIFICATION_FAILED: no private response logged"); process.exitCode = 1; }
finally {
  if (cookie && csrf) await request("/api/session", { method: "DELETE", headers: { Origin: origin, "X-CSRF-Token": csrf } }).catch(() => undefined);
}
