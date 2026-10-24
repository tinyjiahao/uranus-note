import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("preserves schema 3 notes and snapshots when enabling image layout", async () => {
  const db = env.UPGRADE_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 4), "uranus_upgrade_migrations");
  const content = JSON.stringify({ type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "right" } }] });
  await db.batch([
    db.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,content_schema_version,last_operation_id,created_at,updated_at) VALUES(9,1,?,3,'old',1,1)").bind(content),
    db.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES(19,9,?,1,3,'old',0,1,1)").bind(content),
  ]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS, "uranus_upgrade_migrations");
  for (const table of ["uranus_notes", "uranus_note_versions"]) {
    expect(await db.prepare(`SELECT content_schema_version FROM ${table}`).first("content_schema_version")).toBe(3);
    expect(await db.prepare(`SELECT content_json FROM ${table}`).first("content_json")).toBe(content);
    await db.prepare(`UPDATE ${table} SET content_schema_version=4`).run();
    expect(await db.prepare(`SELECT content_schema_version FROM ${table}`).first("content_schema_version")).toBe(4);
  }
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toHaveLength(0);
});
