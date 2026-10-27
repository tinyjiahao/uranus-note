// Synthetic isolated D1/R2; never uses the user's local or production bindings.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { backup, restore, verify, migrate } from "./local-operations.mjs";

const directory = await mkdtemp(resolve(".wrangler/v7-verification-")), proxies = [];
const connect = async name => { const proxy = await getPlatformProxy({ configPath: resolve("tests/v6.wrangler.jsonc"), remoteBindings: false, persist: { path: join(directory, name) } }); proxies.push(proxy); await migrate(proxy.env.DB); return proxy.env; };
try {
  const source = await connect("source"), target = await connect("target");
  const content = JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "label", attrs: { text: "恢复标签", color: "blue" } }, { type: "noteLink", attrs: { noteId: 123, title: "目标快照" } }] },
    { type: "fileAttachment", attrs: { attachmentId: "v7-file", fileName: "fixture.pdf", size: 8, mime: "application/pdf" } },
  ] });
  for (const env of [source, target]) {
    await env.DB.prepare("CREATE TABLE unrelated_v7_probe(value TEXT)").run();
    await env.DB.prepare("INSERT INTO unrelated_v7_probe VALUES('keep')").run();
    await env.UPLOADS.put("other-app/v7-probe", "keep");
  }
  await source.DB.batch([
    source.DB.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,content_schema_version,last_operation_id,created_at,updated_at) VALUES(123,1,?,8,'v7-fixture',1,1)").bind(content),
    source.DB.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES(124,123,?,1,8,'fixture',8,1,1)").bind(content),
    source.DB.prepare("INSERT INTO uranus_attachments(id,note_id,object_key,file_name,mime,size,status,created_at,updated_at) VALUES('v7-file',123,'uranus/attachments/123/v7-file.pdf','fixture.pdf','application/pdf',8,'ready',1,1)"),
    source.DB.prepare("INSERT INTO uranus_attachment_refs(attachment_id,note_id,version_id) VALUES('v7-file',123,NULL),('v7-file',123,124)"),
  ]);
  await source.UPLOADS.put("uranus/attachments/123/v7-file.pdf", "%PDF-1.7");
  const destination = join(directory, "backup"); await backup(source.DB, source.UPLOADS, destination); await verify(destination);
  await restore(target.DB, target.UPLOADS, destination);
  for (const table of ["uranus_notes", "uranus_note_versions"]) {
    const row = await target.DB.prepare(`SELECT content_json,content_schema_version FROM ${table}`).first();
    assert.equal(row.content_json, content); assert.equal(row.content_schema_version, 8);
  }
  assert.equal(await target.DB.prepare("SELECT COUNT(*) FROM uranus_attachment_refs").first("COUNT(*)"), 2);
  assert.equal(await (await target.UPLOADS.get("uranus/attachments/123/v7-file.pdf")).text(), "%PDF-1.7");
  for (const env of [source, target]) { assert.equal(await env.DB.prepare("SELECT value FROM unrelated_v7_probe").first("value"), "keep"); assert.equal(await (await env.UPLOADS.get("other-app/v7-probe")).text(), "keep"); }
  console.log(JSON.stringify({ passed: ["schema8-note-and-history-roundtrip", "label-file-noteLink-preserved", "attachment-bytes-and-refs", "unrelated-D1-R2-preserved"], directory }));
} finally { for (const proxy of proxies) await proxy.dispose(); }
