import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("upgrades existing v1 notes, snapshots and attachment references without touching other applications", async () => {
  const db = env.UPGRADE_DB;
  await db.prepare("CREATE TABLE other_app_sentinel(id INTEGER PRIMARY KEY, value TEXT)").run();
  await db.prepare("INSERT INTO other_app_sentinel VALUES(1,'keep')").run();
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2), "uranus_upgrade_migrations");
  await db.batch([
    db.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,last_operation_id,created_at,updated_at) VALUES(9,1,'{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}','old',1,1)"),
    db.prepare("INSERT INTO uranus_note_search VALUES(9,'title','body',1)"),
    db.prepare("INSERT INTO uranus_note_versions VALUES(19,9,'{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}',1,'old',3,1,1)"),
    db.prepare("INSERT INTO uranus_attachments(id,note_id,object_key,file_name,mime,size,status,created_at,updated_at) VALUES('a',9,'uranus/attachments/9/a.png','old.png','image/png',10,'ready',1,1)"),
    db.prepare("INSERT INTO uranus_attachment_refs VALUES('a',9,NULL),('a',9,19)"),
  ]);
  await applyD1Migrations(db, env.TEST_MIGRATIONS, "uranus_upgrade_migrations");
  expect(await db.prepare("SELECT content_schema_version FROM uranus_notes WHERE id=9").first("content_schema_version")).toBe(1);
  expect(await db.prepare("SELECT content_schema_version FROM uranus_note_versions WHERE id=19").first("content_schema_version")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM uranus_attachment_refs").first("n")).toBe(2);
  expect(await db.prepare("SELECT normalized_text FROM uranus_note_search WHERE note_id=9").first("normalized_text")).toBe("body");
  expect(await db.prepare("SELECT value FROM other_app_sentinel WHERE id=1").first("value")).toBe("keep");
  await db.prepare("UPDATE uranus_notes SET content_schema_version=2 WHERE id=9").run();
  expect(await db.prepare("SELECT content_schema_version FROM uranus_notes WHERE id=9").first("content_schema_version")).toBe(2);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toHaveLength(0);
});
