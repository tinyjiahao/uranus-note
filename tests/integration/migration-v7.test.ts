import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("upgrades schema columns without changing old content, references or other applications", async () => {
  const db = env.UPGRADE_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 9), "uranus_v7_upgrade_migrations");
  const content = '{"type":"doc","content":[{"type":"paragraph"}]}';
  await db.batch([
    db.prepare("CREATE TABLE other_v7_probe(id INTEGER PRIMARY KEY,value TEXT)"),
    db.prepare("INSERT INTO other_v7_probe VALUES(1,'keep')"),
    db.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,content_schema_version,last_operation_id,created_at,updated_at) VALUES(79,1,?,5,'old-v5',1,1)").bind(content),
    db.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES(89,79,?,1,5,'old-v5',0,1,1)").bind(content),
  ]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS, "uranus_v7_upgrade_migrations");
  for (const table of ["uranus_notes", "uranus_note_versions"]) {
    expect(await db.prepare(`SELECT content_schema_version FROM ${table}`).first("content_schema_version")).toBe(5);
    expect(await db.prepare(`SELECT content_json FROM ${table}`).first("content_json")).toBe(content);
    await db.prepare(`UPDATE ${table} SET content_schema_version=8`).run();
    await expect(db.prepare(`UPDATE ${table} SET content_schema_version=100`).run()).rejects.toThrow();
  }
  expect(await db.prepare("SELECT value FROM other_v7_probe").first("value")).toBe("keep");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toHaveLength(0);
});
