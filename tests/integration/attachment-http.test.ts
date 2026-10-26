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
