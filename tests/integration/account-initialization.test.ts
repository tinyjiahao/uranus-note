import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { initializeDefaultAccount } from "../../worker/services/initializeAccount";
import { hashPassword, verifyPassword } from "../../worker/lib/password";
import type { PasswordRecord } from "../../worker/lib/password";

const db = env.UPGRADE_DB;
const maintenanceId = "test-controlled-maintenance";
const input = { email: "admin@example.com", password: "test-admin-password", maintenanceId };
const content = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS, "uranus_account_upgrade_test");
});

async function freeze() {
  await db.prepare("UPDATE uranus_runtime_state SET mode='frozen',maintenance_id=? WHERE id=1").bind(maintenanceId).run();
}
async function addUser(id: string, username = id) {
  const h = await hashPassword("test-other-password");
  await db.prepare(`INSERT INTO uranus_users(id,email,email_normalized,username,username_normalized,
    password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,1,1)`).bind(id, `${id}@example.com`, `${id}@example.com`, username, username,
      h.password_algorithm, h.password_iterations, h.password_salt, h.password_hash).run();
}

it("requires frozen/drained state and never modifies credentials on refusal", async () => {
  await expect(initializeDefaultAccount(db, input)).rejects.toThrow("INITIALIZATION_REQUIRES_FREEZE");
  expect((await db.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(0);
  await freeze();
  await db.prepare(`INSERT INTO uranus_operations(operation_id,scope,request_hash,status,created_at,expires_at)
    VALUES('pending-before-init','note.create','test','pending',1,2)`).run();
  await expect(initializeDefaultAccount(db, input)).rejects.toThrow("INITIALIZATION_NOT_DRAINED");
  expect((await db.prepare("SELECT count(*) n FROM uranus_users").first())?.n).toBe(0);
  await db.prepare("DELETE FROM uranus_operations WHERE operation_id='pending-before-init'").run();
});

it("does not adopt an unmarked account named admin", async () => {
  await freeze();
  await addUser("untrusted-admin", "admin");
  await expect(initializeDefaultAccount(db, input)).rejects.toThrow();
  expect(await db.prepare("SELECT * FROM uranus_account_state").first()).toBeNull();
  expect((await db.prepare("SELECT user_id FROM uranus_folders WHERE id=1").first())?.user_id).toBeNull();
  await db.prepare("DELETE FROM uranus_users WHERE id='untrusted-admin'").run();
});

it("rolls back every ownership change if an unowned note points to another user's folder", async () => {
  await freeze();
  await addUser("existing-owner");
  await db.prepare("INSERT INTO uranus_folders(id,name,system_key,created_at,updated_at,user_id) VALUES(990,'Notes','default',1,1,'existing-owner')").run();
  await db.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,last_operation_id,created_at,updated_at) VALUES(991,990,?,'legacy',1,1)").bind(content).run();
  await expect(initializeDefaultAccount(db, input)).rejects.toThrow("OWNERSHIP_CONFLICT");
  expect((await db.prepare("SELECT user_id FROM uranus_folders WHERE id=1").first())?.user_id).toBeNull();
  expect(await db.prepare("SELECT * FROM uranus_account_state").first()).toBeNull();
  await db.prepare("DELETE FROM uranus_notes WHERE id=991").run();
  await db.prepare("DELETE FROM uranus_folders WHERE id=990").run();
  await db.prepare("DELETE FROM uranus_users WHERE id='existing-owner'").run();
});

it("migrates legacy data atomically, preserves existing ownership and reuses the default Notes", async () => {
  await freeze();
  await db.prepare("CREATE TABLE another_app_records(id INTEGER PRIMARY KEY, value TEXT)").run();
  await db.prepare("INSERT INTO another_app_records VALUES(1,'untouched')").run();
  await env.UPLOADS.put("another-app/untouched", "keep");
  await addUser("existing-owner");
  await db.batch([
    db.prepare("INSERT INTO uranus_folders(id,name,system_key,created_at,updated_at,user_id) VALUES(990,'Notes','default',1,1,'existing-owner')"),
    db.prepare("INSERT INTO uranus_notes(id,folder_id,user_id,content_json,last_operation_id,created_at,updated_at) VALUES(992,990,'existing-owner',?,'existing',1,1)").bind(content),
    db.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,revision,deleted_at,last_operation_id,created_at,updated_at) VALUES(993,1,?,7,5,'legacy',1,2)").bind(content),
    db.prepare("INSERT INTO uranus_note_versions(id,note_id,content_json,content_schema_v1,content_schema_version,title,char_count,source_revision,created_at) VALUES(994,993,?,1,5,'',0,7,2)").bind(content),
    db.prepare("INSERT INTO uranus_note_search(note_id,normalized_title,normalized_text,source_revision) VALUES(993,'','',7)"),
    db.prepare("INSERT INTO uranus_attachments(id,note_id,object_key,file_name,mime,size,status,created_at,updated_at) VALUES('legacy-image',993,'uranus/attachments/legacy-image','image','image/png',3,'ready',1,1)"),
    db.prepare("INSERT INTO uranus_attachment_refs(attachment_id,note_id,version_id) VALUES('legacy-image',993,994)"),
    db.prepare("INSERT INTO uranus_operations(operation_id,scope,request_hash,status,created_at,expires_at) VALUES('legacy-operation','note.patch','hash','succeeded',1,2)"),
    db.prepare("INSERT INTO uranus_maintenance_jobs(id,kind,status,created_at,updated_at) VALUES('legacy-job','purge_note:993','queued',1,1)"),
  ]);
  await env.UPLOADS.put("uranus/attachments/legacy-image", "png");
  const before = await db.prepare("SELECT content_json,revision,deleted_at,updated_at FROM uranus_notes WHERE id=993").first();
  const result = await initializeDefaultAccount(db, input);
  expect(result.created).toBe(true);
  expect((await db.prepare("SELECT user_id FROM uranus_folders WHERE id=1").first())?.user_id).toBe(result.userId);
  expect((await db.prepare("SELECT user_id FROM uranus_notes WHERE id=993").first())?.user_id).toBe(result.userId);
  expect((await db.prepare("SELECT user_id FROM uranus_notes WHERE id=992").first())?.user_id).toBe("existing-owner");
  expect(await db.prepare("SELECT content_json,revision,deleted_at,updated_at FROM uranus_notes WHERE id=993").first()).toEqual(before);
  expect((await db.prepare("SELECT count(*) n FROM uranus_folders WHERE user_id=? AND system_key='default'").bind(result.userId).first())?.n).toBe(1);
  expect((await db.prepare("SELECT user_id FROM uranus_operations WHERE operation_id='legacy-operation'").first())?.user_id).toBe(result.userId);
  expect((await db.prepare("SELECT user_id FROM uranus_maintenance_jobs WHERE id='legacy-job'").first())?.user_id).toBe(result.userId);
  expect((await db.prepare("SELECT mode FROM uranus_runtime_state WHERE id=1").first())?.mode).toBe("frozen");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toHaveLength(0);
  expect((await db.prepare("SELECT value FROM another_app_records WHERE id=1").first())?.value).toBe("untouched");
  expect(await (await env.UPLOADS.get("another-app/untouched"))?.text()).toBe("keep");
  expect(await (await env.UPLOADS.get("uranus/attachments/legacy-image"))?.text()).toBe("png");

  // The stable marker, not the mutable display name or email, drives retries.
  await db.prepare("UPDATE uranus_users SET username='Renamed',username_normalized='renamed',email='changed@example.com',email_normalized='changed@example.com' WHERE id=?").bind(result.userId).run();
  const again = await initializeDefaultAccount(db, { ...input, password: "different-password" });
  expect(again).toEqual({ userId: result.userId, created: false });
  const row = (await db.prepare("SELECT * FROM uranus_users WHERE id=?").bind(result.userId).first<PasswordRecord>())!;
  expect(await verifyPassword(input.password, row)).toBe(true);
  expect(await verifyPassword("different-password", row)).toBe(false);
  expect((await db.prepare("SELECT email FROM uranus_users WHERE id=?").bind(result.userId).first())?.email).toBe("changed@example.com");

  await expect(db.prepare("UPDATE uranus_notes SET folder_id=990 WHERE id=993").run()).rejects.toThrow("OWNERSHIP_CONFLICT");
  await expect(db.prepare("UPDATE uranus_notes SET user_id='existing-owner',folder_id=990 WHERE id=993").run()).rejects.toThrow("OWNER_IMMUTABLE");
  await expect(db.prepare("INSERT INTO uranus_notes(id,folder_id,content_json,last_operation_id,created_at,updated_at) VALUES(995,1,?,'missing-owner',1,1)").bind(content).run()).rejects.toThrow("OWNER_REQUIRED");
  await expect(db.prepare("INSERT INTO uranus_attachment_refs(attachment_id,note_id) VALUES('legacy-image',992)").run()).rejects.toThrow("REFERENCE_PARENT_CONFLICT");
});
