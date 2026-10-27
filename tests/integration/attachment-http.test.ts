import { initializeTestAccount, testAccount } from "../accountFixture";
import { beforeAll } from "vitest";
beforeAll(initializeTestAccount);
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { app } from "../../worker/index";
import { createNote } from "../../worker/services/notes";
import { uuidv7 } from "../../src/api/client";

const origin = "http://uranus.test";
async function authHeaders() {
  const response = await app.request(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(testAccount) }, env);
  expect(response.status).toBe(200);
  const session = await response.json<{ csrfToken: string }>();
  return { Cookie: response.headers.get("Set-Cookie")!.split(";")[0]!, Origin: origin, "X-CSRF-Token": session.csrfToken };
}

it("uploads multipart bytes through authenticated HTTP and downloads them privately", async () => {
  const headers = await authHeaders();
  const created = await app.request(origin + "/api/notes", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: uuidv7(), content_schema_version: 2 }) }, env);
  expect(created.status).toBe(201);
  const note = await created.json<{ id: number }>();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const form = new FormData(); form.set("note_id", String(note.id)); form.set("operation_id", uuidv7()); form.set("file", new File([bytes], "test.png", { type: "image/png" }));
  const encoded = new Request(`${origin}/api/attachments`, { method: "POST", body: form });
  const body = await encoded.arrayBuffer();
  const response = await app.request(`${origin}/api/attachments`, { method: "POST", headers: { ...headers, "Content-Type": encoded.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) }, body }, env);
  expect(response.status).toBe(201);
  const attachment = await response.json<{ url: string; size: number }>(); expect(attachment.size).toBe(bytes.length);
  const download = await app.request(origin + attachment.url, { headers }, env);
  expect(download.status).toBe(200); expect(download.headers.get("Content-Type")).toBe("image/png");
  expect(download.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  const cached = await app.request(origin + attachment.url, { headers: { ...headers, "If-None-Match": download.headers.get("ETag")! } }, env);
  expect(cached.status).toBe(304);
  expect(cached.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  expect((await app.request(origin + "/api/session", { headers }, env)).headers.get("Cache-Control")).toBe("no-store");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  expect((await app.request(origin + attachment.url, {}, env)).status).toBe(401);
});

it("rejects incorrect content types and missing multipart boundaries without a 500", async () => {
  const headers = await authHeaders();
  for (const [contentType, status, code] of [["application/json", 415, "INVALID_UPLOAD_CONTENT_TYPE"], ["multipart/form-data", 400, "INVALID_UPLOAD_FORM"]] as const) {
    const response = await app.request(`${origin}/api/attachments`, { method: "POST", headers: { ...headers, "Content-Type": contentType, "Content-Length": "2" }, body: "{}" }, env);
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error: { code } });
  }
});

it("forces safe file download, protects conditional requests and rejects forged MIME bytes", async () => {
  const headers = await authHeaders();
  const created = await app.request(origin + "/api/notes", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: uuidv7() }) }, env);
  const note = await created.json<{ id: number }>();
  for (const [mime, bytes, status] of [["application/pdf", "%PDF-1.7", 201], ["application/pdf", "<html>", 415], ["text/plain", "a".repeat(100) + "\0", 415], ["text/markdown", "# UTF-8 正文", 201]] as const) {
    const form = new FormData(); form.set("note_id", String(note.id)); form.set("operation_id", uuidv7()); form.set("file", new File([bytes], "test-file", { type: mime }));
    const encoded = new Request(origin, { method: "POST", body: form }), body = await encoded.arrayBuffer();
    const uploaded = await app.request(origin + "/api/attachments", { method: "POST", headers: { ...headers, "Content-Type": encoded.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) }, body }, env);
    expect(uploaded.status).toBe(status);
    if (status !== 201) continue;
    const attachment = await uploaded.json<{ url: string }>();
    const download = await app.request(origin + attachment.url, { headers }, env);
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(download.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await download.text()).toBe(bytes);
    const etag = download.headers.get("ETag")!;
    const anonymous = await app.request(origin + attachment.url, { headers: { "If-None-Match": etag } }, env);
    expect(anonymous.status).toBe(401); expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
    const conditional = await app.request(origin + attachment.url, { headers: { ...headers, "If-None-Match": etag } }, env);
    expect(conditional.status).toBe(304); expect(conditional.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  }
});
